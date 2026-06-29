const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const paths = require("./paths");
const { exists, readJson, writeJson } = require("./fsutil");
const { init, loadTask, recordEvent } = require("./state");
const { validateChangedPaths } = require("./pathScope");
const db = require("./db");

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function codexSubagentPath(cwd, importId) {
  return paths.advisoryPath(cwd, "codex-subagents", importId);
}

function normalizeImport(cwd, input) {
  assertObject(input, "codex subagents import");
  const taskId = input.task_id || input.subject_id;
  assertString(taskId, "codex subagents task_id");
  const task = loadTask(cwd, taskId);
  const changedPaths = validateChangedPaths(input.changed_paths, task, {
    label: "codex subagents changed_paths[]",
    scope_label: "Codex subagents changed_paths"
  });
  const subagents = arrayOrEmpty(input.subagents).map((agent, index) => {
    if (typeof agent === "string") return { name: agent, role: "codex_subagent", status: "reported" };
    assertObject(agent, `codex subagents subagents[${index}]`);
    assertString(agent.name, `codex subagents subagents[${index}].name`);
    return {
      name: agent.name,
      role: agent.role || "codex_subagent",
      status: agent.status || "reported",
      summary: agent.summary || "",
      outputs: arrayOrEmpty(agent.outputs),
      recommendations: arrayOrEmpty(agent.recommendations)
    };
  });
  if (!subagents.length) throw new Error("codex subagents import requires at least one subagent");
  if (input.advisory_only === false) throw new Error("codex subagents imports must be advisory_only");
  return {
    import_id: input.import_id || `CS-${crypto.randomUUID()}`,
    task_id: task.task_id,
    goal_id: task.goal_id,
    task_owner: task.owner,
    reviewer: task.reviewer,
    facet: task.facet,
    source: input.source || "codex-native-subagents",
    mode: input.mode || "parallel_worker_evidence",
    summary: input.summary || "",
    subagents,
    changed_paths: changedPaths,
    outputs: arrayOrEmpty(input.outputs),
    recommendations: arrayOrEmpty(input.recommendations),
    blockers: arrayOrEmpty(input.blockers),
    advisory_only: true,
    execution_evidence: true,
    codex_state_authority: true,
    imported_at: input.imported_at || new Date().toISOString()
  };
}

function importCodexSubagents(cwd, input) {
  init(cwd);
  const record = normalizeImport(cwd, input);
  writeJson(codexSubagentPath(cwd, record.import_id), record);
  db.upsertAdvisory(cwd, "codex-subagents", record.import_id, record, {
    task_id: record.task_id,
    goal_id: record.goal_id
  });
  recordEvent(cwd, {
    type: "codex_subagents.imported",
    goal_id: record.goal_id,
    task_id: record.task_id,
    owner: record.task_owner,
    reviewer: record.reviewer,
    detail: {
      import_id: record.import_id,
      subagents: record.subagents.map((agent) => agent.name),
      changed_paths: record.changed_paths,
      advisory_only: true,
      execution_evidence: true,
      codex_state_authority: true
    }
  });
  return record;
}

function loadCodexSubagentImport(cwd, importId) {
  const file = codexSubagentPath(cwd, importId);
  return exists(file) ? readJson(file) : null;
}

function listCodexSubagentImports(cwd, filter = {}) {
  const dir = path.join(paths.stateDir(cwd), "advisory", "codex-subagents");
  if (!fs.existsSync(dir)) return [];
  let rows = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(dir, name)));
  if (filter.task_id) rows = rows.filter((row) => row.task_id === filter.task_id);
  return rows;
}

module.exports = {
  importCodexSubagents,
  loadCodexSubagentImport,
  listCodexSubagentImports,
  normalizeImport
};
