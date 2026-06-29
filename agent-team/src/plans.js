const fs = require("node:fs");
const path = require("node:path");
const { exists, readJson, readJsonl, writeJson, writeText } = require("./fsutil");
const paths = require("./paths");
const { init, loadGoal, recordEvent } = require("./state");
const { findMailboxResponse } = require("./mailbox");
const db = require("./db");

const PLAN_AUTHORS = new Set(["codex", "claude", "reconciled"]);

function assertGoal(cwd, goalId) {
  loadGoal(cwd, goalId);
}

function readBodyFromInput(cwd, input) {
  if (typeof input.body === "string" && input.body.trim() !== "") return input.body;
  if (typeof input.file === "string" && input.file.trim() !== "") {
    return fs.readFileSync(path.resolve(cwd, input.file), "utf8");
  }
  throw new Error("plan body requires --text or --file");
}

function planMetadata(goalId, author, metadata = {}) {
  return [
    `Goal: ${goalId}`,
    `Author: ${author}`,
    `Recorded: ${new Date().toISOString()}`,
    ...Object.entries(metadata)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}: ${value}`)
  ].join("\n");
}

function renderPlan(goalId, author, body, metadata = {}) {
  return [`# ${author} plan for ${goalId}`, "", planMetadata(goalId, author, metadata), "", "## Plan", "", body.trim()].join("\n");
}

function savePlan(cwd, { goal_id, author, body, file, metadata = {} }) {
  init(cwd);
  assertGoal(cwd, goal_id);
  if (!PLAN_AUTHORS.has(author)) throw new Error(`invalid plan author: ${author}`);
  const text = readBodyFromInput(cwd, { body, file });
  const outputPath = paths.planPath(cwd, goal_id, author);
  const rendered = renderPlan(goal_id, author, text, metadata);
  writeText(outputPath, rendered);
  db.upsertPlan(cwd, {
    goal_id,
    author,
    path: outputPath,
    body: rendered,
    recorded_at: new Date().toISOString()
  });
  recordEvent(cwd, {
    type: "plan.saved",
    goal_id,
    actor: author,
    detail: {
      author,
      path: path.relative(cwd, outputPath)
    }
  });
  return {
    ok: true,
    goal_id,
    author,
    path: outputPath
  };
}

function responseText(response) {
  if (!response) return "";
  if (typeof response.answer === "string" && response.answer.trim() !== "") return response.answer;
  if (typeof response.text === "string" && response.text.trim() !== "") return response.text;
  if (response.payload !== undefined) return JSON.stringify(response.payload, null, 2);
  return JSON.stringify(response, null, 2);
}

function findResponse(cwd, requestId) {
  const mailboxResponse = findMailboxResponse(cwd, { request_id: requestId, kind: "plan_review" });
  if (mailboxResponse) return mailboxResponse;
  const responses = readJsonl(paths.responsesPath(cwd));
  const matches = requestId
    ? responses.filter((row) => row.request_id === requestId || row.channel_request_id === requestId)
    : responses.filter((row) => row.kind === "plan_review" || /^G-\d+$/.test(row.task_id || ""));
  return matches[matches.length - 1] || null;
}

function importClaudePlan(cwd, { goal_id, request_id }) {
  init(cwd);
  assertGoal(cwd, goal_id);
  const response = findResponse(cwd, request_id);
  if (!response) {
    throw new Error(request_id ? `no response found for request ${request_id}` : "no Claude plan response found");
  }
  if (response.result_state && response.result_state !== "answered") {
    throw new Error(`Claude plan response is not answered: ${response.result_state}`);
  }
  return savePlan(cwd, {
    goal_id,
    author: "claude",
    body: responseText(response),
    metadata: {
      "Source request": response.request_id,
      Adapter: response.adapter,
      "Result state": response.result_state
    }
  });
}

function ensurePlanExists(cwd, goalId, author) {
  const file = paths.planPath(cwd, goalId, author);
  if (!exists(file)) throw new Error(`${author} plan is required for ${goalId}`);
  return file;
}

function reconcilePlan(cwd, { goal_id, body, file, notes = [] }) {
  init(cwd);
  assertGoal(cwd, goal_id);
  const codexPath = ensurePlanExists(cwd, goal_id, "codex");
  const claudePath = ensurePlanExists(cwd, goal_id, "claude");
  const reconciled = savePlan(cwd, {
    goal_id,
    author: "reconciled",
    body,
    file,
    metadata: {
      "Codex plan": codexPath,
      "Claude plan": claudePath
    }
  });
  const decision = {
    goal_id,
    status: "reconciled",
    decided_at: new Date().toISOString(),
    inputs: {
      codex: codexPath,
      claude: claudePath
    },
    output: reconciled.path,
    notes
  };
  writeJson(paths.planDecisionPath(cwd, goal_id), decision);
  recordEvent(cwd, {
    type: "plan.reconciled",
    goal_id,
    detail: {
      codex_plan: path.relative(cwd, codexPath),
      claude_plan: path.relative(cwd, claudePath),
      reconciled_plan: path.relative(cwd, reconciled.path),
      decision_path: path.relative(cwd, paths.planDecisionPath(cwd, goal_id))
    }
  });
  return {
    ok: true,
    goal_id,
    codex_plan: codexPath,
    claude_plan: claudePath,
    reconciled_plan: reconciled.path,
    decision_path: paths.planDecisionPath(cwd, goal_id)
  };
}

function loadPlanSummary(cwd, goalId) {
  const summary = {
    goal_id: goalId,
    codex: exists(paths.planPath(cwd, goalId, "codex")),
    claude: exists(paths.planPath(cwd, goalId, "claude")),
    reconciled: exists(paths.planPath(cwd, goalId, "reconciled")),
    decision: exists(paths.planDecisionPath(cwd, goalId)) ? readJson(paths.planDecisionPath(cwd, goalId)) : null
  };
  return summary;
}

function devPromotionEvidence(cwd, goalId) {
  const codexPath = paths.planPath(cwd, goalId, "codex");
  const claudePath = paths.planPath(cwd, goalId, "claude");
  const reconciledPath = paths.planPath(cwd, goalId, "reconciled");
  const decisionPath = paths.planDecisionPath(cwd, goalId);
  const decision = exists(decisionPath) ? readJson(decisionPath) : null;
  const checks = {
    codex_plan: exists(codexPath),
    claude_plan: exists(claudePath),
    reconciled_plan: exists(reconciledPath),
    decision: Boolean(decision && decision.status === "reconciled")
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    missing: Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name),
    paths: {
      codex_plan: codexPath,
      claude_plan: claudePath,
      reconciled_plan: reconciledPath,
      decision: decisionPath
    }
  };
}

function assertDevPromotionAllowed(cwd, goalId, degradedReason) {
  init(cwd);
  assertGoal(cwd, goalId);
  const evidence = devPromotionEvidence(cwd, goalId);
  if (evidence.ok) return { ok: true, degraded: false, evidence };
  const reason = typeof degradedReason === "string" ? degradedReason.trim() : "";
  if (!reason) {
    throw new Error(
      `cannot promote ${goalId} to dev: missing ${evidence.missing.join(", ")}; record Codex + Claude + reconciled planning or pass --degraded-reason <reason>`
    );
  }
  recordEvent(cwd, {
    type: "plan.degraded_dev_promotion",
    goal_id: goalId,
    detail: {
      reason,
      missing: evidence.missing
    }
  });
  return { ok: true, degraded: true, reason, evidence };
}

module.exports = {
  savePlan,
  importClaudePlan,
  reconcilePlan,
  loadPlanSummary,
  devPromotionEvidence,
  assertDevPromotionAllowed
};
