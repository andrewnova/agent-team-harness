const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const paths = require("./paths");
const { exists, readJson, writeJson } = require("./fsutil");
const { FRONTEND_FACETS } = require("./schema");
const { loadTask, recordEvent } = require("./state");
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

function agentTeamPath(cwd, importId) {
  return paths.advisoryPath(cwd, "agent-teams", importId);
}

function normalizeImport(cwd, input) {
  assertObject(input, "agent teams import");
  const taskId = input.task_id || input.subject_id;
  assertString(taskId, "agent teams task_id");
  const task = loadTask(cwd, taskId);
  if (task.owner !== "claude" || !FRONTEND_FACETS.has(task.facet)) {
    throw new Error("Claude Agent Teams imports are limited to Claude-owned frontend tasks");
  }
  const changedPaths = validateChangedPaths(input.changed_paths, task, {
    label: "Agent Teams changed_paths[]",
    scope_label: "Agent Teams changed_paths"
  });
  const subagents = arrayOrEmpty(input.subagents).map((agent, index) => {
    if (typeof agent === "string") return { name: agent, role: "frontend_subagent" };
    assertObject(agent, `agent teams subagents[${index}]`);
    assertString(agent.name, `agent teams subagents[${index}].name`);
    return {
      name: agent.name,
      role: agent.role || "frontend_subagent",
      status: agent.status || "reported"
    };
  });
  if (!subagents.length) throw new Error("agent teams import requires at least one subagent");
  return {
    import_id: input.import_id || `AT-${crypto.randomUUID()}`,
    task_id: task.task_id,
    goal_id: task.goal_id,
    owner: "claude",
    reviewer: task.reviewer,
    facet: task.facet,
    source: input.source || "claude-agent-teams",
    mode: "frontend_accelerator",
    summary: input.summary || "",
    subagents,
    changed_paths: changedPaths,
    outputs: arrayOrEmpty(input.outputs),
    recommendations: arrayOrEmpty(input.recommendations),
    blockers: arrayOrEmpty(input.blockers),
    advisory_only: true,
    codex_state_authority: true,
    imported_at: input.imported_at || new Date().toISOString()
  };
}

function importAgentTeams(cwd, input) {
  const record = normalizeImport(cwd, input);
  writeJson(agentTeamPath(cwd, record.import_id), record);
  db.upsertAdvisory(cwd, "agent-teams", record.import_id, record, {
    task_id: record.task_id,
    goal_id: record.goal_id
  });
  recordEvent(cwd, {
    type: "agent_teams.imported",
    goal_id: record.goal_id,
    task_id: record.task_id,
    owner: record.owner,
    reviewer: record.reviewer,
    detail: {
      import_id: record.import_id,
      subagents: record.subagents.map((agent) => agent.name),
      changed_paths: record.changed_paths,
      advisory_only: true,
      codex_state_authority: true
    }
  });
  return record;
}

function loadAgentTeamImport(cwd, importId) {
  const file = agentTeamPath(cwd, importId);
  return exists(file) ? readJson(file) : null;
}

function listAgentTeamImports(cwd, filter = {}) {
  const dir = path.join(paths.stateDir(cwd), "advisory", "agent-teams");
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
  importAgentTeams,
  loadAgentTeamImport,
  listAgentTeamImports,
  normalizeImport
};
