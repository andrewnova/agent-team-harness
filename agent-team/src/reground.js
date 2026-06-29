const { readJson, readJsonl, writeJson } = require("./fsutil");
const paths = require("./paths");
const { loadTask, recordEvent, listEvents } = require("./state");
const { createBridge } = require("./bridge");
const { parseJsonish } = require("./review");
const { findMailboxResponse } = require("./mailbox");
const db = require("./db");

function validateReground(cwd, packet) {
  const task = loadTask(cwd, packet.task_id);
  const drift = [];
  if (packet.restated_objective && packet.restated_objective !== task.objective) {
    drift.push({
      file: paths.taskPath(cwd, task.task_id),
      claimed: packet.restated_objective,
      actual: task.objective
    });
  }
  if (Array.isArray(packet.restated_acceptance)) {
    const actual = JSON.stringify(task.acceptance_criteria);
    const claimed = JSON.stringify(packet.restated_acceptance);
    if (actual !== claimed) {
      drift.push({
        file: paths.taskPath(cwd, task.task_id),
        claimed,
        actual
      });
    }
  }
  return {
    faithful: drift.length === 0,
    drift
  };
}

function storeReground(cwd, packet) {
  const result = validateReground(cwd, packet);
  if (!result.faithful) {
    const task = loadTask(cwd, packet.task_id);
    recordEvent(cwd, {
      type: "reground.rejected",
      goal_id: task.goal_id,
      task_id: task.task_id,
      owner: task.owner,
      reviewer: task.reviewer,
      status: task.status,
      detail: {
        drift: result.drift.length,
        source: packet.source
      }
    });
    return { ok: false, errors: ["reground packet drifted from canonical task"], drift: result.drift };
  }
  const task = loadTask(cwd, packet.task_id);
  let sequence = 1;
  let file = paths.regroundPath(cwd, packet.task_id, sequence);
  while (require("node:fs").existsSync(file)) {
    sequence += 1;
    file = paths.regroundPath(cwd, packet.task_id, sequence);
  }
  const row = {
    stored_at: new Date().toISOString(),
    ...packet,
    divergences_from_files: packet.divergences_from_files || []
  };
  writeJson(file, row);
  db.upsertReground(cwd, packet.task_id, sequence, row);
  recordEvent(cwd, {
    type: "reground.stored",
    goal_id: task.goal_id,
    task_id: task.task_id,
    owner: task.owner,
    reviewer: task.reviewer,
    status: task.status,
    detail: {
      source: packet.source,
      file: require("node:path").relative(cwd, file),
      sequence
    }
  });
  return { ok: true, file, packet: readJson(file) };
}

function buildRegroundPrompt(cwd, task, extraPrompt = "") {
  const recentEvents = listEvents(cwd, { task_id: task.task_id, limit: 12 });
  return [
    `Re-ground Codex on task ${task.task_id}.`,
    "",
    "Return only JSON matching this schema:",
    JSON.stringify(
      {
        task_id: task.task_id,
        source: "claude",
        base_tree_hash: "current git hash or unknown",
        restated_objective: task.objective,
        restated_acceptance: task.acceptance_criteria,
        active_tasks_state: ["short faithful state summary"],
        open_decisions: ["decision still open"],
        divergences_from_files: [],
        corrections: [],
        open_questions: []
      },
      null,
      2
    ),
    "",
    "Rules:",
    "- Be compact and literal. Do not invent requirements.",
    "- restated_objective must match the canonical task objective exactly unless you report the mismatch in divergences_from_files.",
    "- restated_acceptance must match the canonical acceptance criteria exactly unless you report the mismatch in divergences_from_files.",
    "- Use open_questions for uncertainty instead of guessing.",
    "",
    "Canonical task JSON:",
    JSON.stringify(task, null, 2),
    "",
    "Recent task events:",
    JSON.stringify(recentEvents, null, 2),
    extraPrompt ? ["", "Extra instructions:", extraPrompt].join("\n") : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function requestReground(cwd, taskId, options = {}) {
  const task = loadTask(cwd, taskId);
  const adapter = createBridge(options.adapter || "mailbox");
  const row = adapter.request(cwd, {
    task_id: taskId,
    kind: "reground",
    owner: task.owner,
    reviewer: task.reviewer,
    task_snapshot: task,
    prompt: buildRegroundPrompt(cwd, task, options.prompt || options.extra_prompt || ""),
    target: options.target,
    timeout_ms: options.timeout_ms
  });
  recordEvent(cwd, {
    type: "reground.requested",
    goal_id: task.goal_id,
    task_id: task.task_id,
    owner: task.owner,
    reviewer: task.reviewer,
    status: task.status,
    detail: {
      adapter: row.adapter,
      request_id: row.request_id,
      target: row.target || options.target
    }
  });
  return row;
}

function responseText(response) {
  if (!response) return "";
  if (typeof response.answer === "string") return response.answer;
  if (typeof response.text === "string") return response.text;
  if (typeof response.stdout === "string") return response.stdout;
  if (response.payload !== undefined) return JSON.stringify(response.payload);
  return JSON.stringify(response);
}

function findRegroundResponse(cwd, taskId, requestId) {
  const mailboxResponse = findMailboxResponse(cwd, { task_id: taskId, request_id: requestId, kind: "reground" });
  if (mailboxResponse) return mailboxResponse;
  const responses = readJsonl(paths.responsesPath(cwd));
  const matches = requestId
    ? responses.filter((row) => row.request_id === requestId || row.channel_request_id === requestId)
    : responses.filter((row) => row.task_id === taskId && row.kind === "reground");
  return matches[matches.length - 1] || null;
}

function normalizePacket(task, payload) {
  const packet = {
    source: "claude",
    base_tree_hash: "unknown",
    divergences_from_files: [],
    corrections: [],
    open_questions: [],
    ...payload,
    task_id: payload.task_id || task.task_id
  };
  if (typeof packet.restated_objective !== "string" || packet.restated_objective.trim() === "") {
    throw new Error("reground response must include restated_objective");
  }
  if (!Array.isArray(packet.restated_acceptance)) {
    throw new Error("reground response must include restated_acceptance array");
  }
  return packet;
}

function importReground(cwd, taskId, options = {}) {
  const task = loadTask(cwd, taskId);
  const response = findRegroundResponse(cwd, taskId, options.request_id);
  if (!response) {
    throw new Error(options.request_id ? `no reground response found for request ${options.request_id}` : `no reground response found for ${taskId}`);
  }
  if (response.result_state && response.result_state !== "answered") {
    throw new Error(`reground response is not answered: ${response.result_state}`);
  }
  const payload = response.payload !== undefined ? response.payload : parseJsonish(responseText(response));
  const packet = normalizePacket(task, parseJsonish(payload));
  const stored = storeReground(cwd, packet);
  return {
    ok: stored.ok,
    task_id: taskId,
    request_id: response.request_id,
    channel_request_id: response.channel_request_id,
    ...stored
  };
}

module.exports = {
  validateReground,
  storeReground,
  buildRegroundPrompt,
  requestReground,
  importReground
};
