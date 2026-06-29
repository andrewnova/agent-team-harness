const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const paths = require("./paths");
const { exists, readJson, writeJson } = require("./fsutil");
const { loadTask, recordEvent } = require("./state");
const db = require("./db");

const SCOPES = new Set(["repo", "goal", "task"]);
const KINDS = new Set(["planning", "review", "debug", "architecture", "quality"]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
}

function normalizeCouncil(input) {
  assertObject(input, "moa council");
  const scope = input.scope || (input.task_id ? "task" : input.goal_id ? "goal" : "repo");
  if (!SCOPES.has(scope)) throw new Error("moa scope must be repo, goal, or task");
  const kind = input.kind || "review";
  if (!KINDS.has(kind)) throw new Error("moa kind must be planning, review, debug, architecture, or quality");
  const subjectId = input.subject_id || input.task_id || input.goal_id || "repo";
  if (scope !== "repo") assertString(subjectId, "moa subject_id");
  assertString(input.question, "moa question");
  assertArray(input.participants, "moa participants");
  if (input.participants.length < 2) throw new Error("moa requires at least two participants");
  const decisionOwner = input.decision_owner || input.synthesis?.decision_owner || "codex";
  if (decisionOwner !== "codex") throw new Error("moa decision_owner must be codex");
  if (input.advisory_only === false) throw new Error("moa records must be advisory_only");
  return {
    council_id: input.council_id || `MOA-${crypto.randomUUID()}`,
    scope,
    subject_id: subjectId,
    kind,
    question: input.question,
    participants: input.participants.map((participant, index) => {
      assertObject(participant, `moa participants[${index}]`);
      assertString(participant.agent, `moa participants[${index}].agent`);
      return {
        agent: participant.agent,
        role: participant.role || participant.agent,
        verdict: participant.verdict || "advice",
        confidence: participant.confidence || "medium",
        rationale: participant.rationale || "",
        recommendations: Array.isArray(participant.recommendations) ? participant.recommendations : []
      };
    }),
    synthesis: {
      decision_owner: "codex",
      decision: input.synthesis?.decision || input.decision || "",
      accepted: Array.isArray(input.synthesis?.accepted) ? input.synthesis.accepted : [],
      rejected: Array.isArray(input.synthesis?.rejected) ? input.synthesis.rejected : [],
      next_action: input.synthesis?.next_action || input.next_action || ""
    },
    advisory_only: true,
    recorded_at: input.recorded_at || new Date().toISOString()
  };
}

function moaPath(cwd, councilId) {
  return paths.advisoryPath(cwd, "moa", councilId);
}

function recordMoa(cwd, input) {
  const council = normalizeCouncil(input);
  let goalId;
  let taskStatus;
  let owner;
  let reviewer;
  let taskId;
  if (council.scope === "task") {
    const task = loadTask(cwd, council.subject_id);
    goalId = task.goal_id;
    taskStatus = task.status;
    owner = task.owner;
    reviewer = task.reviewer;
    taskId = task.task_id;
  }
  const record = {
    ...council,
    task_id: taskId,
    goal_id: goalId || (council.scope === "goal" ? council.subject_id : undefined)
  };
  writeJson(moaPath(cwd, council.council_id), record);
  db.upsertAdvisory(cwd, "moa", council.council_id, record, {
    task_id: taskId,
    goal_id: goalId,
    verdict: record.synthesis.decision
  });
  recordEvent(cwd, {
    type: "moa.recorded",
    goal_id: goalId,
    task_id: taskId,
    owner,
    reviewer,
    status: taskStatus,
    detail: {
      council_id: record.council_id,
      scope: record.scope,
      kind: record.kind,
      participants: record.participants.map((participant) => participant.agent),
      advisory_only: true,
      decision_owner: "codex"
    }
  });
  return record;
}

function loadMoa(cwd, councilId) {
  const file = moaPath(cwd, councilId);
  return exists(file) ? readJson(file) : null;
}

function listMoa(cwd, filter = {}) {
  const dir = path.join(paths.stateDir(cwd), "advisory", "moa");
  if (!fs.existsSync(dir)) return [];
  let rows = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(dir, name)));
  if (filter.scope) rows = rows.filter((row) => row.scope === filter.scope);
  if (filter.subject_id) rows = rows.filter((row) => row.subject_id === filter.subject_id);
  if (filter.kind) rows = rows.filter((row) => row.kind === filter.kind);
  return rows;
}

module.exports = {
  recordMoa,
  loadMoa,
  listMoa,
  normalizeCouncil
};
