const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const paths = require("./paths");
const { appendJsonl, exists, readJson, writeJson } = require("./fsutil");
const state = require("./state");
const db = require("./db");

const FEEDBACK_KIND = "user-feedback";
const SELF_HEAL_KIND = "self-heal-recommendations";

function now() {
  return new Date().toISOString();
}

function advisoryDir(cwd, kind) {
  return path.join(paths.stateDir(cwd), "advisory", kind);
}

function advisoryPath(cwd, kind, id) {
  return paths.advisoryPath(cwd, kind, id);
}

function listKind(cwd, kind, filter = {}) {
  const dir = advisoryDir(cwd, kind);
  if (!fs.existsSync(dir)) return [];
  let rows = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(dir, name)));
  if (filter.status) rows = rows.filter((row) => row.status === filter.status);
  if (filter.goal_id) rows = rows.filter((row) => row.goal_id === filter.goal_id);
  if (filter.task_id) rows = rows.filter((row) => row.task_id === filter.task_id);
  if (filter.source) rows = rows.filter((row) => row.source === filter.source);
  if (filter.scope) rows = rows.filter((row) => row.scope === filter.scope);
  if (filter.type) rows = rows.filter((row) => row.type === filter.type);
  if (Number.isInteger(filter.limit) && filter.limit > 0) rows = rows.slice(-filter.limit);
  return rows;
}

function recordFeedback(cwd, input = {}) {
  state.init(cwd);
  if (!input.text || !String(input.text).trim()) throw new Error("feedback record requires --text");
  const timestamp = now();
  const id = input.feedback_id || `FB-${crypto.randomUUID().slice(0, 8)}`;
  const record = {
    feedback_id: id,
    source: input.source || "user",
    scope: input.scope || "harness",
    status: "recorded",
    goal_id: input.goal_id,
    task_id: input.task_id,
    text: input.text,
    advisory_only: true,
    codex_state_authority: true,
    recorded_at: timestamp,
    updated_at: timestamp
  };
  writeJson(advisoryPath(cwd, FEEDBACK_KIND, id), record);
  db.upsertAdvisory(cwd, FEEDBACK_KIND, id, record, { task_id: record.task_id, goal_id: record.goal_id });
  state.recordEvent(cwd, {
    type: "feedback.recorded",
    actor: record.source,
    goal_id: record.goal_id,
    task_id: record.task_id,
    detail: {
      feedback_id: id,
      scope: record.scope
    }
  });
  return { ok: true, feedback: record };
}

function loadFeedback(cwd, feedbackId) {
  const file = advisoryPath(cwd, FEEDBACK_KIND, feedbackId);
  return exists(file) ? readJson(file) : null;
}

function listFeedback(cwd, filter = {}) {
  return listKind(cwd, FEEDBACK_KIND, filter);
}

function latestFeedbackSummary(cwd, filter = {}) {
  const rows = listFeedback(cwd, { ...filter, limit: filter.limit || 5 });
  if (!rows.length) return "";
  return rows.map((row) => `${row.feedback_id}: ${row.text}`).join("\n");
}

function recommendSelfHeal(cwd, input = {}) {
  state.init(cwd);
  const timestamp = now();
  const id = input.recommendation_id || `SH-${crypto.randomUUID().slice(0, 8)}`;
  const recommendation = input.recommendation || input.text || latestFeedbackSummary(cwd, {
    goal_id: input.goal_id,
    task_id: input.task_id
  });
  if (!recommendation || !String(recommendation).trim()) {
    throw new Error("self-heal recommend requires --recommendation or recorded feedback");
  }
  const record = {
    recommendation_id: id,
    type: input.type || "self_heal",
    source: input.source || "codex",
    scope: input.scope || "harness",
    target_surface: input.target_surface || input.surface || "harness",
    change_request: Boolean(input.change_request),
    status: "recommended",
    goal_id: input.goal_id,
    task_id: input.task_id,
    title: input.title || "Harness self-heal recommendation",
    reason: input.reason || "User feedback or scope drift indicates the harness may need an adjustment.",
    recommendation,
    requires_user_confirmation: true,
    approved: false,
    applied: false,
    advisory_only: true,
    codex_state_authority: true,
    created_at: timestamp,
    updated_at: timestamp
  };
  writeJson(advisoryPath(cwd, SELF_HEAL_KIND, id), record);
  db.upsertAdvisory(cwd, SELF_HEAL_KIND, id, record, { task_id: record.task_id, goal_id: record.goal_id });
  state.recordEvent(cwd, {
    type: "self_heal.recommended",
    actor: record.source,
    goal_id: record.goal_id,
    task_id: record.task_id,
    detail: {
      recommendation_id: id,
      recommendation_type: record.type,
      target_surface: record.target_surface,
      requires_user_confirmation: true
    }
  });
  return { ok: true, recommendation: record };
}

function requestToolChange(cwd, input = {}) {
  const source = input.source || input.from || "claude";
  const targetSurface = input.target_surface || input.surface || "harness";
  const request = input.request || input.recommendation || input.text;
  if (!request || !String(request).trim()) throw new Error("self-heal request-change requires --request");
  return recommendSelfHeal(cwd, {
    ...input,
    source,
    scope: input.scope || "self-heal",
    target_surface: targetSurface,
    type: "tool_change_request",
    change_request: true,
    title: input.title || `Proposed ${targetSurface} improvement`,
    reason: input.reason || "A model or user noticed an on-the-fly harness improvement opportunity.",
    recommendation: request
  });
}

function postGoalSelfHealOffer(cwd, input = {}) {
  const context = selfHealContext(cwd, {
    goal_id: input.goal_id,
    task_id: input.task_id,
    limit: input.limit || 5
  });
  const globalContext = selfHealContext(cwd, { limit: input.limit || 5 });
  const targetArgs = [
    input.goal_id ? `--goal ${input.goal_id}` : null,
    input.task_id ? `--task ${input.task_id}` : null
  ]
    .filter(Boolean)
    .join(" ");
  const signalIds = new Set();
  for (const row of [
    ...context.pending_recommendations,
    ...context.approved_unapplied,
    ...context.recent_feedback,
    ...globalContext.pending_recommendations,
    ...globalContext.approved_unapplied,
    ...globalContext.recent_feedback
  ]) {
    signalIds.add(row.recommendation_id || row.feedback_id);
  }
  const signalCount = signalIds.size;
  const prompt = [
    "Review the completed goal/task and recommend confirmation-gated self-heal changes for the Agent Team Harness.",
    "Look for brittle commands, missed ACKs, unclear skill instructions, failed delivery paths, noisy waits, tool gaps, and user feedback that would make the next run better.",
    "Do not mutate code, config, tasks, or policy directly. Propose changes with self-heal recommend/request-change so the user can approve them first.",
    "Both Codex and Claude may submit recommendations; Codex remains final state and proof owner."
  ].join("\n");
  return {
    offered: true,
    type: "post_goal_self_heal_offer",
    question: "Review this completed goal for harness self-heal improvements?",
    requires_user_confirmation: true,
    state_mutation: "none_until_user_approves_self_heal",
    goal_id: input.goal_id,
    task_id: input.task_id,
    recent_signal_count: signalCount,
    context_command: `self-heal context${targetArgs ? ` ${targetArgs}` : ""} --limit 10`,
    global_context_command: "self-heal context --limit 10",
    recommended_command: `self-heal recommend${targetArgs ? ` ${targetArgs}` : ""} --source codex --surface harness --title "Post-goal harness self-heal" --recommendation "<recommended improvement>"`,
    prompt_preview: prompt
  };
}

function selfHealContext(cwd, filter = {}) {
  const limit = filter.limit || 8;
  const pending = listSelfHealRecommendations(cwd, {
    status: "recommended",
    goal_id: filter.goal_id,
    task_id: filter.task_id,
    source: filter.source,
    scope: filter.scope,
    limit
  });
  const approvedUnapplied = listSelfHealRecommendations(cwd, {
    status: "approved",
    goal_id: filter.goal_id,
    task_id: filter.task_id,
    source: filter.source,
    scope: filter.scope
  })
    .filter((row) => !row.applied)
    .slice(-limit);
  const recentFeedback = listFeedback(cwd, {
    goal_id: filter.goal_id,
    task_id: filter.task_id,
    source: filter.source,
    scope: filter.scope,
    limit
  });
  return {
    ok: true,
    read_before_harness_changes: true,
    pending_recommendations: pending,
    pending_tool_change_requests: pending.filter((row) => row.type === "tool_change_request" || row.change_request),
    approved_unapplied: approvedUnapplied,
    recent_feedback: recentFeedback,
    policy: {
      durable_source: ".agent-team/state/advisory/self-heal-recommendations",
      db_role: "sqlite indexes advisory records for inspection/recovery; JSON remains authority",
      confirmation_required: true,
      codex_state_authority: true
    }
  };
}

function loadSelfHealRecommendation(cwd, recommendationId) {
  const file = advisoryPath(cwd, SELF_HEAL_KIND, recommendationId);
  return exists(file) ? readJson(file) : null;
}

function listSelfHealRecommendations(cwd, filter = {}) {
  return listKind(cwd, SELF_HEAL_KIND, filter);
}

function decideSelfHealRecommendation(cwd, recommendationId, input = {}) {
  state.init(cwd);
  const record = loadSelfHealRecommendation(cwd, recommendationId);
  if (!record) return { ok: false, error: `self-heal recommendation not found: ${recommendationId}` };
  const decision = input.decision || "approved";
  if (!["approved", "rejected"].includes(decision)) throw new Error("self-heal decision must be approved or rejected");
  const timestamp = now();
  const updated = {
    ...record,
    status: decision,
    approved: decision === "approved",
    rejected: decision === "rejected",
    applied: false,
    user_note: input.note || record.user_note || "",
    decided_at: timestamp,
    updated_at: timestamp
  };
  writeJson(advisoryPath(cwd, SELF_HEAL_KIND, recommendationId), updated);
  appendJsonl(paths.approvalsPath(cwd), {
    approval_id: `APP-${crypto.randomUUID().slice(0, 8)}`,
    kind: "self-heal",
    recommendation_id: recommendationId,
    decision,
    note: updated.user_note,
    recorded_at: timestamp
  });
  db.upsertAdvisory(cwd, SELF_HEAL_KIND, recommendationId, updated, {
    task_id: updated.task_id,
    goal_id: updated.goal_id
  });
  state.recordEvent(cwd, {
    type: `self_heal.${decision}`,
    actor: "human",
    goal_id: updated.goal_id,
    task_id: updated.task_id,
    detail: {
      recommendation_id: recommendationId,
      applied: false,
      note: updated.user_note
    }
  });
  return { ok: true, recommendation: updated };
}

function markSelfHealApplied(cwd, recommendationId, input = {}) {
  state.init(cwd);
  const record = loadSelfHealRecommendation(cwd, recommendationId);
  if (!record) return { ok: false, error: `self-heal recommendation not found: ${recommendationId}` };
  if (!record.approved) {
    throw new Error(`self-heal recommendation ${recommendationId} must be approved before it can be marked applied`);
  }
  const timestamp = now();
  const updated = {
    ...record,
    status: "applied",
    applied: true,
    applied_note: input.note || record.applied_note || "",
    applied_evidence: input.evidence || record.applied_evidence || "",
    applied_at: timestamp,
    updated_at: timestamp
  };
  writeJson(advisoryPath(cwd, SELF_HEAL_KIND, recommendationId), updated);
  db.upsertAdvisory(cwd, SELF_HEAL_KIND, recommendationId, updated, {
    task_id: updated.task_id,
    goal_id: updated.goal_id
  });
  state.recordEvent(cwd, {
    type: "self_heal.applied",
    actor: "codex",
    goal_id: updated.goal_id,
    task_id: updated.task_id,
    detail: {
      recommendation_id: recommendationId,
      evidence: updated.applied_evidence,
      note: updated.applied_note
    }
  });
  return { ok: true, recommendation: updated };
}

module.exports = {
  recordFeedback,
  listFeedback,
  loadFeedback,
  recommendSelfHeal,
  requestToolChange,
  postGoalSelfHealOffer,
  selfHealContext,
  listSelfHealRecommendations,
  loadSelfHealRecommendation,
  decideSelfHealRecommendation,
  markSelfHealApplied
};
