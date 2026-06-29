const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const paths = require("./paths");
const { exists, readJson, writeJson } = require("./fsutil");
const state = require("./state");
const db = require("./db");

const OFFER_KIND = "refactor-offers";
const RECOMMENDATION_KIND = "refactor-recommendations";
const COMPARISON_KIND = "refactor-comparisons";
const FRONTEND_HINTS = /\b(frontend|ui|ux|visual|copy|layout|browser|responsive|accessib|css|component)\b/i;

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function now() {
  return new Date().toISOString();
}

function shortId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function listAdvisory(cwd, kind, filter = {}) {
  const dir = path.join(paths.stateDir(cwd), "advisory", kind);
  if (!fs.existsSync(dir)) return [];
  let rows = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(dir, name)));
  if (filter.status) rows = rows.filter((row) => row.status === filter.status);
  if (filter.goal_id) rows = rows.filter((row) => row.goal_id === filter.goal_id);
  if (filter.task_id) rows = rows.filter((row) => row.task_id === filter.task_id);
  if (filter.run_id) rows = rows.filter((row) => row.run_id === filter.run_id);
  if (filter.source) rows = rows.filter((row) => row.source === filter.source);
  if (Number.isInteger(filter.limit) && filter.limit > 0) rows = rows.slice(-filter.limit);
  return rows;
}

function loadAdvisory(cwd, kind, id) {
  const file = paths.advisoryPath(cwd, kind, id);
  return exists(file) ? readJson(file) : null;
}

function saveAdvisory(cwd, kind, id, record, options = {}) {
  writeJson(paths.advisoryPath(cwd, kind, id), record);
  db.upsertAdvisory(cwd, kind, id, record, options);
  return record;
}

function loadTaskOrNull(cwd, taskId) {
  if (!taskId || !exists(paths.taskPath(cwd, taskId))) return null;
  return state.loadTask(cwd, taskId);
}

function loadGoalOrNull(cwd, goalId) {
  if (!goalId || !exists(paths.goalPath(cwd, goalId))) return null;
  return state.loadGoal(cwd, goalId);
}

function refactorPrompt(input = {}) {
  const goalLine = input.goal_id ? `Goal: ${input.goal_id}` : "Goal: current completed build/workstream";
  const taskLine = input.task_id ? `Task: ${input.task_id}` : "Task: post-build architecture and quality pass";
  const scopeLine = input.scope ? `Scope: ${input.scope}` : "Scope: repository/workstream completed by the harness";
  return [
    "Refactor until you are happy with the architecture.",
    goalLine,
    taskLine,
    scopeLine,
    "",
    "After each significant step, live-test the system with the local proof surfaces needed to verify end to end.",
    "Find bugs during refactor; do not introduce them. Use high/xhigh effort, autoreview, cross-model review, and commit discipline.",
    "Track progress in the DB, runs, events, advisory records, task goal prompts, and proof artifacts. Use as many useful Codex native subagents and Claude Agent Teams as safely possible.",
    "Every created task must be tied to the goal and include a goal prompt.",
    "Claude owns frontend, UX, copy, visual QA, and frontend browser observation. Codex owns backend, state, proof, integration, computer-use/browser-use verification, merge, and final state.",
    "Codex compares Claude and Codex recommendations, decides the final task breakdown, and remains final state/proof authority.",
    "Self-heal or scope-changing recommendations are advisory until the user explicitly confirms them."
  ].join("\n");
}

function offerCommand(offer) {
  const parts = ["refactor", "start", offer.offer_id];
  return parts.join(" ");
}

function postBuildRefactorOffer(cwd, input = {}) {
  const task = loadTaskOrNull(cwd, input.task_id);
  const goalId = input.goal_id || task?.goal_id;
  const prompt = refactorPrompt({ goal_id: goalId, task_id: task?.task_id || input.task_id, scope: input.scope });
  return {
    offered: true,
    type: "post_build_refactor_loop",
    question: "Trigger a Codex+Claude refactor loop now?",
    requires_user_confirmation: true,
    state_mutation: "none_until_refactor_start",
    recommended_command: `refactor offer${goalId ? ` --goal ${goalId}` : ""}${task?.task_id || input.task_id ? ` --task ${task?.task_id || input.task_id}` : ""}`,
    prompt_sha256: sha256(prompt),
    prompt_preview: prompt.slice(0, 700)
  };
}

function recordRefactorOffer(cwd, input = {}) {
  state.init(cwd);
  const task = loadTaskOrNull(cwd, input.task_id);
  const goalId = input.goal_id || task?.goal_id;
  const prompt = input.prompt || refactorPrompt({ goal_id: goalId, task_id: task?.task_id || input.task_id, scope: input.scope });
  const id = input.offer_id || shortId("RO");
  const timestamp = now();
  const record = {
    offer_id: id,
    kind: "post_build_refactor_loop",
    status: "offered",
    goal_id: goalId,
    task_id: task?.task_id || input.task_id,
    title: input.title || "Post-build Codex+Claude refactor loop",
    scope: input.scope || "repo",
    prompt,
    prompt_sha256: sha256(prompt),
    codex_prompt: prompt,
    claude_prompt: prompt,
    requires_user_confirmation: true,
    advisory_only: true,
    codex_state_authority: true,
    created_at: timestamp,
    updated_at: timestamp
  };
  record.recommended_next_commands = [
    offerCommand(record),
    `refactor import --run <run-id> --source codex --json codex-refactor.json`,
    `refactor import --run <run-id> --source claude --json claude-refactor.json`,
    `refactor compare --run <run-id>`,
    `refactor taskify --run <run-id> --create`
  ];
  saveAdvisory(cwd, OFFER_KIND, id, record, { task_id: record.task_id, goal_id: record.goal_id });
  state.recordEvent(cwd, {
    type: "refactor_offer.created",
    goal_id: record.goal_id,
    task_id: record.task_id,
    detail: {
      offer_id: id,
      prompt_sha256: record.prompt_sha256,
      requires_user_confirmation: true
    }
  });
  return { ok: true, offer: record };
}

function startRefactorOffer(cwd, offerId, input = {}) {
  state.init(cwd);
  const offer = loadRefactorOffer(cwd, offerId);
  if (!offer) return { ok: false, error: `refactor offer not found: ${offerId}` };
  const run = state.createRun(cwd, {
    kind: "post_build_refactor",
    title: input.title || offer.title || "Post-build Codex+Claude refactor loop",
    owner: "codex",
    mode: "refactor",
    goal_id: input.goal_id || offer.goal_id,
    task_id: input.task_id || offer.task_id,
    summary: "User-confirmed post-build refactor loop. Codex compares Codex and Claude recommendations, taskifies the accepted work, then runs normal review/proof/done gates.",
    metadata: {
      offer_id: offer.offer_id,
      prompt_sha256: offer.prompt_sha256,
      requires_user_confirmation: true,
      confirmed: true,
      confirmed_at: now(),
      codex_final_authority: true
    }
  });
  const updated = {
    ...offer,
    status: "accepted",
    accepted_run_id: run.run_id,
    accepted_at: now(),
    updated_at: now()
  };
  saveAdvisory(cwd, OFFER_KIND, offer.offer_id, updated, { task_id: updated.task_id, goal_id: updated.goal_id });
  state.recordEvent(cwd, {
    type: "refactor_offer.accepted",
    goal_id: updated.goal_id,
    task_id: updated.task_id,
    run_id: run.run_id,
    detail: {
      offer_id: updated.offer_id,
      prompt_sha256: updated.prompt_sha256
    }
  });
  return {
    ok: true,
    run,
    offer: updated,
    codex_prompt: updated.codex_prompt,
    claude_prompt: updated.claude_prompt,
    next_commands: [
      `refactor import --run ${run.run_id} --source codex --json codex-refactor.json`,
      `refactor import --run ${run.run_id} --source claude --json claude-refactor.json`,
      `refactor compare --run ${run.run_id}`,
      `refactor taskify --run ${run.run_id} --create`
    ]
  };
}

function normalizeRecommendation(cwd, input = {}) {
  const run = state.loadRun(cwd, input.run_id);
  const source = input.source || "codex";
  if (!["codex", "claude"].includes(source)) throw new Error("refactor recommendation source must be codex or claude");
  const prompt = input.prompt || run.metadata?.prompt || refactorPrompt({ goal_id: run.goal_id, task_id: run.task_id, scope: input.scope });
  const record = {
    recommendation_id: input.recommendation_id || shortId(source === "claude" ? "RR-CLAUDE" : "RR-CODEX"),
    run_id: run.run_id,
    goal_id: input.goal_id || run.goal_id,
    task_id: input.task_id || run.task_id,
    source,
    status: "imported",
    prompt_sha256: input.prompt_sha256 || run.metadata?.prompt_sha256 || sha256(prompt),
    recommendations: Array.isArray(input.recommendations) ? input.recommendations : [],
    risks: Array.isArray(input.risks) ? input.risks : [],
    task_candidates: Array.isArray(input.task_candidates) ? input.task_candidates : [],
    summary: input.summary || "",
    raw_text: input.raw_text || input.text || "",
    advisory_only: true,
    codex_state_authority: true,
    imported_at: input.imported_at || now()
  };
  return record;
}

function importRefactorRecommendation(cwd, input = {}) {
  state.init(cwd);
  const record = normalizeRecommendation(cwd, input);
  saveAdvisory(cwd, RECOMMENDATION_KIND, record.recommendation_id, record, {
    task_id: record.task_id,
    goal_id: record.goal_id
  });
  state.recordEvent(cwd, {
    type: "refactor_recommendation.imported",
    actor: record.source,
    goal_id: record.goal_id,
    task_id: record.task_id,
    run_id: record.run_id,
    detail: {
      recommendation_id: record.recommendation_id,
      recommendations: record.recommendations.length,
      task_candidates: record.task_candidates.length,
      advisory_only: true
    }
  });
  return { ok: true, recommendation: record };
}

function compareRefactorRecommendations(cwd, input = {}) {
  state.init(cwd);
  const run = state.loadRun(cwd, input.run_id);
  const recommendations = listRefactorRecommendations(cwd, { run_id: run.run_id });
  const codex = recommendations.find((row) => row.source === "codex");
  const claude = recommendations.find((row) => row.source === "claude");
  const id = input.comparison_id || shortId("RC");
  const record = {
    comparison_id: id,
    run_id: run.run_id,
    goal_id: run.goal_id,
    task_id: run.task_id,
    status: "compared",
    decision_owner: "codex",
    advisory_only: true,
    codex_state_authority: true,
    inputs: recommendations.map((row) => ({
      recommendation_id: row.recommendation_id,
      source: row.source,
      task_candidates: row.task_candidates.length,
      risks: row.risks.length
    })),
    accepted_sources: {
      codex: Boolean(codex),
      claude: Boolean(claude)
    },
    synthesis: input.synthesis || "Codex owns final state. Use Claude advice for frontend/UX work and Codex advice for backend/state/proof work; taskify accepted candidates through normal gates.",
    created_at: now()
  };
  saveAdvisory(cwd, COMPARISON_KIND, id, record, { task_id: record.task_id, goal_id: record.goal_id });
  state.recordEvent(cwd, {
    type: "refactor_recommendations.compared",
    goal_id: record.goal_id,
    task_id: record.task_id,
    run_id: record.run_id,
    detail: {
      comparison_id: id,
      recommendation_count: recommendations.length,
      decision_owner: "codex"
    }
  });
  return { ok: true, comparison: record, recommendations };
}

function ownerForCandidate(candidate) {
  const facet = candidate.facet || "";
  const title = candidate.title || "";
  const objective = candidate.objective || candidate.summary || "";
  if (candidate.owner) return candidate.owner;
  if (FRONTEND_HINTS.test(`${facet} ${title} ${objective}`)) return "claude";
  return "codex";
}

function facetForCandidate(candidate, owner) {
  if (candidate.facet) return candidate.facet;
  if (owner === "claude") return "frontend_ui";
  return "backend_api";
}

function normalizeTaskCandidate(candidate, defaults = {}) {
  const owner = ownerForCandidate(candidate);
  const facet = facetForCandidate(candidate, owner);
  return {
    goal_id: candidate.goal_id || defaults.goal_id,
    title: candidate.title || "Refactor task",
    status: candidate.status || "ready",
    owner,
    reviewer: candidate.reviewer || (owner === "claude" ? "codex" : "claude"),
    facet,
    objective: candidate.objective || candidate.summary || "Complete the accepted refactor task.",
    acceptance_criteria: Array.isArray(candidate.acceptance_criteria) ? candidate.acceptance_criteria : ["Refactor keeps existing behavior and passes proof gates"],
    allowed_paths: Array.isArray(candidate.allowed_paths) ? candidate.allowed_paths : [],
    forbidden_paths: Array.isArray(candidate.forbidden_paths) ? candidate.forbidden_paths : [],
    proof: candidate.proof || {
      commands: [],
      requires_browser: owner === "claude",
      requires_screenshot: owner === "claude",
      requires_computer: false
    },
    frontend_contract: candidate.frontend_contract
  };
}

function taskifyRefactor(cwd, input = {}) {
  state.init(cwd);
  const run = state.loadRun(cwd, input.run_id);
  const goalId = input.goal_id || run.goal_id;
  if (!loadGoalOrNull(cwd, goalId)) {
    throw new Error(`refactor taskify requires an existing goal: ${goalId || "<missing>"}`);
  }
  const recommendations = listRefactorRecommendations(cwd, { run_id: run.run_id });
  const rawCandidates = recommendations.flatMap((row) => row.task_candidates || []);
  const tasks = rawCandidates.map((candidate) => normalizeTaskCandidate(candidate, { goal_id: goalId }));
  const created = input.create ? tasks.map((taskInput) => state.createTask(cwd, taskInput)) : [];
  state.recordEvent(cwd, {
    type: input.create ? "refactor_taskify.created_tasks" : "refactor_taskify.proposed",
    goal_id: goalId,
    task_id: run.task_id,
    run_id: run.run_id,
    detail: {
      proposed: tasks.length,
      created: created.map((task) => task.task_id)
    }
  });
  return { ok: true, run_id: run.run_id, goal_id: goalId, proposed_tasks: tasks, created_tasks: created };
}

function loadRefactorOffer(cwd, offerId) {
  return loadAdvisory(cwd, OFFER_KIND, offerId);
}

function listRefactorOffers(cwd, filter = {}) {
  return listAdvisory(cwd, OFFER_KIND, filter);
}

function loadRefactorRecommendation(cwd, recommendationId) {
  return loadAdvisory(cwd, RECOMMENDATION_KIND, recommendationId);
}

function listRefactorRecommendations(cwd, filter = {}) {
  return listAdvisory(cwd, RECOMMENDATION_KIND, filter);
}

function listRefactorComparisons(cwd, filter = {}) {
  return listAdvisory(cwd, COMPARISON_KIND, filter);
}

module.exports = {
  refactorPrompt,
  postBuildRefactorOffer,
  recordRefactorOffer,
  startRefactorOffer,
  listRefactorOffers,
  loadRefactorOffer,
  importRefactorRecommendation,
  loadRefactorRecommendation,
  listRefactorRecommendations,
  compareRefactorRecommendations,
  listRefactorComparisons,
  taskifyRefactor
};
