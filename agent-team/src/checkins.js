const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const paths = require("./paths");
const { exists, readJson, writeJson } = require("./fsutil");
const state = require("./state");
const db = require("./db");

const KIND = "agent-checkins";
const AGENTS = new Set(["codex", "claude", "human"]);

function now() {
  return new Date().toISOString();
}

function checkinPath(cwd, checkinId) {
  return paths.advisoryPath(cwd, KIND, checkinId);
}

function normalizeAgent(agent) {
  const value = agent || "claude";
  if (!AGENTS.has(value)) throw new Error("checkin --from must be codex, claude, or human");
  return value;
}

function recordCheckin(cwd, input = {}) {
  state.init(cwd);
  const agent = normalizeAgent(input.agent || input.from);
  const timestamp = now();
  const id = input.checkin_id || `CI-${crypto.randomUUID().slice(0, 8)}`;
  const record = {
    checkin_id: id,
    source: "agent-checkin",
    agent,
    work_status: input.status || "active",
    ack_status: agent === "claude" && input.steer ? "new" : "informational",
    goal_id: input.goal_id,
    task_id: input.task_id,
    run_id: input.run_id,
    summary: input.summary || "",
    steer: input.steer || "",
    requires_codex_attention: agent === "claude" && Boolean(input.steer),
    advisory_only: true,
    codex_state_authority: true,
    recorded_at: timestamp,
    updated_at: timestamp
  };
  writeJson(checkinPath(cwd, id), record);
  db.upsertAdvisory(cwd, KIND, id, record, { task_id: record.task_id, goal_id: record.goal_id });
  state.recordEvent(cwd, {
    type: "agent_checkin.recorded",
    actor: agent,
    goal_id: record.goal_id,
    task_id: record.task_id,
    run_id: record.run_id,
    detail: {
      checkin_id: id,
      work_status: record.work_status,
      requires_codex_attention: record.requires_codex_attention
    }
  });
  return { ok: true, checkin: record };
}

function loadCheckin(cwd, checkinId) {
  const file = checkinPath(cwd, checkinId);
  return exists(file) ? readJson(file) : null;
}

function listCheckins(cwd, filter = {}) {
  const dir = path.join(paths.stateDir(cwd), "advisory", KIND);
  if (!fs.existsSync(dir)) return [];
  let rows = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(dir, name)));
  if (filter.agent) rows = rows.filter((row) => row.agent === filter.agent);
  if (filter.ack_status) rows = rows.filter((row) => row.ack_status === filter.ack_status);
  if (filter.goal_id) rows = rows.filter((row) => row.goal_id === filter.goal_id);
  if (filter.task_id) rows = rows.filter((row) => row.task_id === filter.task_id);
  if (filter.run_id) rows = rows.filter((row) => row.run_id === filter.run_id);
  if (filter.requires_codex_attention !== undefined) {
    rows = rows.filter((row) => Boolean(row.requires_codex_attention) === Boolean(filter.requires_codex_attention));
  }
  if (Number.isInteger(filter.limit) && filter.limit > 0) rows = rows.slice(-filter.limit);
  return rows;
}

function ackCheckin(cwd, checkinId, input = {}) {
  state.init(cwd);
  const checkin = loadCheckin(cwd, checkinId);
  if (!checkin) return { ok: false, error: `agent check-in not found: ${checkinId}` };
  const status = input.status || "acknowledged";
  const updated = {
    ...checkin,
    ack_status: status,
    codex_note: input.note || checkin.codex_note || "",
    acknowledged_at: now(),
    updated_at: now()
  };
  writeJson(checkinPath(cwd, checkinId), updated);
  db.upsertAdvisory(cwd, KIND, checkinId, updated, { task_id: updated.task_id, goal_id: updated.goal_id });
  state.recordEvent(cwd, {
    type: `agent_checkin.${status}`,
    actor: "codex",
    goal_id: updated.goal_id,
    task_id: updated.task_id,
    run_id: updated.run_id,
    detail: {
      checkin_id: checkinId,
      note: updated.codex_note
    }
  });
  return { ok: true, checkin: updated };
}

module.exports = {
  recordCheckin,
  listCheckins,
  loadCheckin,
  ackCheckin
};
