const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  ensureDir,
  readJson,
  writeJson,
  appendJsonl,
  readJsonl,
  exists
} = require("./fsutil");
const paths = require("./paths");
const { FRONTEND_FACETS, validateGoal, validateTask, validateAttempt, validateRun } = require("./schema");
const db = require("./db");

function defaultConfig() {
  return {
    version: 2,
    state: "sqlite-with-json-mirrors",
    host: "codex",
    frontend_owner: "claude",
    execution_profile: "turbo_parallel",
    token_budget: "unbounded_by_harness",
    codex_native_subagents: {
      enabled: true,
      strategy: "max_useful_parallelism",
      max_concurrent: 6,
      use_for: ["backend", "tests", "review", "docs", "debugging", "proof_prep"],
      ownership: "advisory_or_worktree_execution_under_codex"
    },
    claude_agent_teams: {
      enabled: true,
      strategy: "max_useful_frontend_parallelism",
      max_subagents: "claude_config",
      use_for: ["frontend_ui", "ux_polish", "copy", "visual_qa"],
      ownership: "frontend_accelerator_under_claude"
    },
    parallelism_policy: {
      default: "parallel_first_after_task_split",
      write_isolation: "worktree_or_lease_required",
      shared_file_rule: "no_parallel_same_file_edits_without_explicit_lease",
      merge_owner: "codex",
      proof_owner: "codex",
      unattended_parallel_execution: "deferred_until_daemon_policy_is_approved"
    },
    claude_chrome_extension: "allowed_for_frontend_observation_and_debugging",
    proof_authority: "codex",
    bridge_adapters: ["mailbox", "manual", "mock", "claude-channel"]
  };
}

function mergeObject(defaultValue, currentValue) {
  if (!currentValue || typeof currentValue !== "object" || Array.isArray(currentValue)) return defaultValue;
  return { ...defaultValue, ...currentValue };
}

function normalizeConfig(current = {}) {
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...current,
    version: defaults.version,
    state: defaults.state,
    bridge_adapters: Array.isArray(current.bridge_adapters) ? current.bridge_adapters : defaults.bridge_adapters,
    codex_native_subagents: mergeObject(defaults.codex_native_subagents, current.codex_native_subagents),
    claude_agent_teams: mergeObject(defaults.claude_agent_teams, current.claude_agent_teams),
    parallelism_policy: mergeObject(defaults.parallelism_policy, current.parallelism_policy)
  };
}

function configPath(cwd) {
  return path.join(paths.rootDir(cwd), "config.json");
}

function loadConfig(cwd) {
  const file = configPath(cwd);
  return exists(file) ? normalizeConfig(readJson(file)) : defaultConfig();
}

function saveConfigIfNeeded(cwd) {
  const file = configPath(cwd);
  const current = exists(file) ? readJson(file) : {};
  const config = normalizeConfig(current);
  if (!exists(file) || JSON.stringify(current) !== JSON.stringify(config)) writeJson(file, config);
  return config;
}

function init(cwd) {
  const dirs = [
    paths.rootDir(cwd),
    path.join(paths.stateDir(cwd), "goals"),
    path.join(paths.stateDir(cwd), "tasks"),
    path.join(paths.stateDir(cwd), "runs"),
    path.join(paths.stateDir(cwd), "attempts"),
    path.join(paths.stateDir(cwd), "events"),
    path.join(paths.stateDir(cwd), "reviews"),
    path.join(paths.stateDir(cwd), "plans"),
    path.join(paths.stateDir(cwd), "proof"),
    path.join(paths.stateDir(cwd), "merges"),
    path.join(paths.stateDir(cwd), "leases"),
    paths.daemonDir(cwd),
    path.join(paths.stateDir(cwd), "worktrees"),
    path.join(paths.stateDir(cwd), "advisory"),
    path.join(paths.stateDir(cwd), "advisory", "moa"),
    path.join(paths.stateDir(cwd), "advisory", "agent-teams"),
    path.join(paths.stateDir(cwd), "advisory", "codex-subagents"),
    path.join(paths.stateDir(cwd), "advisory", "agent-checkins"),
    path.join(paths.stateDir(cwd), "advisory", "refactor-offers"),
    path.join(paths.stateDir(cwd), "advisory", "refactor-recommendations"),
    path.join(paths.stateDir(cwd), "advisory", "refactor-comparisons"),
    path.join(paths.stateDir(cwd), "advisory", "user-feedback"),
    path.join(paths.stateDir(cwd), "advisory", "self-heal-recommendations"),
    path.join(paths.stateDir(cwd), "advisory", "mailbox-messages"),
    path.join(paths.stateDir(cwd), "advisory", "mailbox-acks"),
    path.join(paths.stateDir(cwd), "regrounds"),
    path.join(paths.stateDir(cwd), "policies"),
    paths.commsDir(cwd),
    paths.mailboxBodiesDir(cwd),
    path.join(paths.rootDir(cwd), "comms", "claude-channel"),
    path.join(paths.rootDir(cwd), "evidence"),
    paths.worktreesDir(cwd),
    path.join(paths.rootDir(cwd), "handoffs"),
    path.join(paths.rootDir(cwd), "projections", "plans"),
    path.join(paths.rootDir(cwd), "projections", "tasks")
  ];
  for (const dir of dirs) ensureDir(dir);
  const config = saveConfigIfNeeded(cwd);
  db.initDatabase(cwd);
  return { root: paths.rootDir(cwd), config };
}

function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(dir, name)));
}

function listGoals(cwd) {
  return listJson(path.join(paths.stateDir(cwd), "goals"));
}

function listTasks(cwd) {
  return listJson(path.join(paths.stateDir(cwd), "tasks"));
}

function listRuns(cwd, filter = {}) {
  let runs = listJson(path.join(paths.stateDir(cwd), "runs"));
  if (filter.status) runs = runs.filter((run) => run.status === filter.status);
  if (filter.kind) runs = runs.filter((run) => run.kind === filter.kind);
  if (filter.goal_id) runs = runs.filter((run) => run.goal_id === filter.goal_id);
  if (filter.task_id) runs = runs.filter((run) => run.task_id === filter.task_id);
  if (Number.isInteger(filter.limit) && filter.limit > 0) runs = runs.slice(-filter.limit);
  return runs;
}

function recordEvent(cwd, event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("event must be an object");
  }
  if (typeof event.type !== "string" || event.type.trim() === "") {
    throw new Error("event.type must be a non-empty string");
  }
  const row = {
    event_id: event.event_id || `evt_${crypto.randomUUID()}`,
    recorded_at: event.recorded_at || new Date().toISOString(),
    actor: event.actor || "codex",
    ...event
  };
  appendJsonl(paths.eventsPath(cwd), row);
  db.insertEvent(cwd, row);
  return row;
}

function listEvents(cwd, filter = {}) {
  let events = readJsonl(paths.eventsPath(cwd));
  if (filter.task_id) events = events.filter((event) => event.task_id === filter.task_id);
  if (filter.goal_id) events = events.filter((event) => event.goal_id === filter.goal_id);
  if (filter.type) events = events.filter((event) => event.type === filter.type);
  if (Number.isInteger(filter.limit) && filter.limit > 0) events = events.slice(-filter.limit);
  return events;
}

function saveGoal(cwd, goal) {
  validateGoal(goal);
  writeJson(paths.goalPath(cwd, goal.goal_id), goal);
  db.upsertGoal(cwd, goal);
  return goal;
}

function saveTask(cwd, task) {
  validateTask(task);
  writeJson(paths.taskPath(cwd, task.task_id), task);
  db.upsertTask(cwd, task);
  return task;
}

function saveRun(cwd, run) {
  validateRun(run);
  writeJson(paths.runPath(cwd, run.run_id), run);
  db.upsertRun(cwd, run);
  return run;
}

function loadTask(cwd, taskId) {
  return readJson(paths.taskPath(cwd, taskId));
}

function loadRun(cwd, runId) {
  return readJson(paths.runPath(cwd, runId));
}

function loadGoal(cwd, goalId) {
  return readJson(paths.goalPath(cwd, goalId));
}

function nextId(items, prefix, key) {
  let max = 0;
  for (const item of items) {
    const id = item[key] || "";
    const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(6, "0")}`;
}

function createGoal(cwd, { title, objective }) {
  init(cwd);
  const goal = {
    goal_id: nextId(listGoals(cwd), "G", "goal_id"),
    title,
    objective,
    acceptance_intent: objective,
    status: "goal",
    created_at: new Date().toISOString()
  };
  const saved = saveGoal(cwd, goal);
  recordEvent(cwd, {
    type: "goal.created",
    goal_id: saved.goal_id,
    detail: {
      title: saved.title
    }
  });
  return saved;
}

function updateGoal(cwd, goalId, input = {}) {
  init(cwd);
  const goal = loadGoal(cwd, goalId);
  const before = { title: goal.title, objective: goal.objective, status: goal.status };
  if (typeof input.title === "string" && input.title.trim() !== "") goal.title = input.title;
  if (typeof input.objective === "string" && input.objective.trim() !== "") {
    goal.objective = input.objective;
    goal.acceptance_intent = input.objective;
  }
  if (typeof input.status === "string" && input.status.trim() !== "") goal.status = input.status;
  const saved = saveGoal(cwd, goal);
  recordEvent(cwd, {
    type: "goal.updated",
    goal_id: saved.goal_id,
    detail: {
      before,
      after: { title: saved.title, objective: saved.objective, status: saved.status }
    }
  });
  return saved;
}

function defaultReviewer(owner) {
  if (owner === "claude") return "codex";
  if (owner === "codex") return "claude";
  return "human";
}

function defaultAccelerationPolicy(input, { owner, facet }) {
  const provided = input.acceleration_policy || {};
  const claudeFrontend = owner === "claude" && FRONTEND_FACETS.has(facet);
  return {
    execution_profile: provided.execution_profile || "turbo_parallel",
    codex_subagents: provided.codex_subagents || "max_useful_parallelism",
    claude_agent_teams: provided.claude_agent_teams || (claudeFrontend ? "max_useful_frontend_parallelism" : "frontend_only_when_task_is_claude_owned"),
    token_budget: provided.token_budget || "unbounded_by_harness",
    write_isolation: provided.write_isolation || "worktree_or_lease_required_for_parallel_writes",
    codex_final_authority: provided.codex_final_authority ?? true,
    max_codex_subagents: provided.max_codex_subagents ?? 6,
    max_claude_agent_team_subagents: provided.max_claude_agent_team_subagents ?? "claude_config"
  };
}

function defaultGoalPrompt(task) {
  const criteria = task.acceptance_criteria.length ? task.acceptance_criteria.map((item) => `- ${item}`).join("\n") : "- No acceptance criteria recorded";
  const allowed = task.allowed_paths.length ? task.allowed_paths.map((item) => `- ${item}`).join("\n") : "- No allowed paths recorded";
  const forbidden = task.forbidden_paths.length ? task.forbidden_paths.map((item) => `- ${item}`).join("\n") : "- No forbidden paths recorded";
  const commands = task.proof.commands.length ? task.proof.commands.map((item) => `- ${item}`).join("\n") : "- No deterministic command recorded yet";
  const ownerLane =
    task.owner === "claude"
      ? "Claude owns this task because it is frontend/UX/visual/copy-oriented. Use Claude Agent Teams when useful, send Codex check-ins when steering is needed, and expect Codex proof/review."
      : "Codex owns this task because it is backend/state/proof/integration-oriented. Use max useful Codex native subagents for independent slices and expect Claude review.";
  return [
    `Goal: ${task.goal_id}`,
    `Task: ${task.task_id}`,
    `Owner: ${task.owner}`,
    `Reviewer: ${task.reviewer}`,
    `Facet: ${task.facet}`,
    "",
    "Objective:",
    task.objective,
    "",
    "Acceptance criteria:",
    criteria,
    "",
    "Path scope:",
    "Allowed:",
    allowed,
    "Forbidden:",
    forbidden,
    "",
    "Proof expectations:",
    commands,
    `Requires browser: ${task.proof.requires_browser}`,
    `Requires screenshot: ${task.proof.requires_screenshot}`,
    `Requires computer use: ${Boolean(task.proof.requires_computer)}`,
    "",
    ownerLane,
    "Track attempts, check-ins, reviews, proof, and handoffs in the harness DB/JSON state.",
    "If stuck after the configured attempt budget, hand off with history instead of spinning."
  ].join("\n");
}

function createTask(cwd, input) {
  init(cwd);
  const owner = input.owner || (String(input.facet || "").startsWith("frontend") ? "claude" : "codex");
  const facet = input.facet || "backend_api";
  const now = new Date().toISOString();
  const task = {
    task_id: input.task_id || nextId(listTasks(cwd), "T", "task_id"),
    goal_id: input.goal_id,
    title: input.title,
    status: input.status || "ready",
    owner,
    reviewer: input.reviewer || defaultReviewer(owner),
    facet,
    objective: input.objective,
    acceptance_criteria: input.acceptance_criteria || [],
    allowed_paths: input.allowed_paths || [],
    forbidden_paths: input.forbidden_paths || [],
    owner_history: input.owner_history || [
      {
        at: now,
        from: null,
        to: owner,
        reason: input.owner_reason || "initial routing"
      }
    ],
    tool_permissions: input.tool_permissions || {
      claude_chrome_extension: owner === "claude" && ["frontend_ui", "ux_polish", "copy", "visual_qa"].includes(facet),
      codex_browser_proof: Boolean(input.proof?.requires_browser || input.proof?.requires_screenshot),
      codex_computer_use: Boolean(input.proof?.requires_computer)
    },
    proof: {
      commands: input.proof?.commands || [],
      requires_browser: Boolean(input.proof?.requires_browser),
      requires_screenshot: Boolean(input.proof?.requires_screenshot),
      requires_computer: Boolean(input.proof?.requires_computer)
    },
    frontend_contract: input.frontend_contract,
    acceleration_policy: defaultAccelerationPolicy(input, { owner, facet }),
    escalation_policy: {
      max_attempts_per_owner: input.escalation_policy?.max_attempts_per_owner || 3,
      after_both_models_fail: input.escalation_policy?.after_both_models_fail || "human"
    }
  };
  task.goal_prompt = input.goal_prompt || defaultGoalPrompt(task);
  const saved = saveTask(cwd, task);
  recordEvent(cwd, {
    type: "task.created",
    goal_id: saved.goal_id,
    task_id: saved.task_id,
    owner: saved.owner,
    reviewer: saved.reviewer,
    status: saved.status,
    detail: {
      title: saved.title,
      facet: saved.facet
    }
  });
  return saved;
}

function inferredGoalForRun(cwd, taskId, explicitGoalId) {
  if (explicitGoalId) return explicitGoalId;
  if (!taskId) return undefined;
  const file = paths.taskPath(cwd, taskId);
  if (!exists(file)) return undefined;
  return readJson(file).goal_id;
}

function createRun(cwd, input = {}) {
  init(cwd);
  const now = new Date().toISOString();
  const run = {
    run_id: input.run_id || nextId(listRuns(cwd), "R", "run_id"),
    kind: input.kind || "manual",
    title: input.title || "Untitled coordination run",
    status: "active",
    owner: input.owner || "codex",
    mode: input.mode,
    goal_id: inferredGoalForRun(cwd, input.task_id, input.goal_id),
    task_id: input.task_id,
    summary: input.summary || "",
    evidence: input.evidence || [],
    metadata: input.metadata || {},
    started_at: now,
    updated_at: now
  };
  const saved = saveRun(cwd, run);
  recordEvent(cwd, {
    type: "run.started",
    goal_id: saved.goal_id,
    task_id: saved.task_id,
    actor: saved.owner,
    status: saved.status,
    run_id: saved.run_id,
    detail: {
      title: saved.title,
      kind: saved.kind,
      mode: saved.mode
    }
  });
  return saved;
}

function completeRun(cwd, runId, input = {}) {
  const run = loadRun(cwd, runId);
  const now = new Date().toISOString();
  const status = input.status || "complete";
  if (status === "active") throw new Error("run complete requires terminal status: complete, failed, or cancelled");
  const updated = {
    ...run,
    status,
    summary: input.summary !== undefined ? input.summary : run.summary,
    outcome: input.outcome !== undefined ? input.outcome : run.outcome,
    evidence: input.evidence || run.evidence || [],
    completed_at: now,
    updated_at: now
  };
  const saved = saveRun(cwd, updated);
  recordEvent(cwd, {
    type: `run.${saved.status}`,
    goal_id: saved.goal_id,
    task_id: saved.task_id,
    actor: saved.owner,
    status: saved.status,
    run_id: saved.run_id,
    detail: {
      title: saved.title,
      kind: saved.kind,
      summary: saved.summary,
      evidence: saved.evidence
    }
  });
  return saved;
}

function changeOwner(cwd, taskId, owner, reason) {
  const task = loadTask(cwd, taskId);
  if (task.owner === owner) return saveTask(cwd, task);
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error("owner override reason is required when changing owner");
  }
  const previous = task.owner;
  task.owner = owner;
  task.reviewer = defaultReviewer(owner);
  task.owner_history = task.owner_history || [];
  task.owner_history.push({
    at: new Date().toISOString(),
    from: previous,
    to: owner,
    reason
  });
  const saved = saveTask(cwd, task);
  recordEvent(cwd, {
    type: "owner.changed",
    goal_id: saved.goal_id,
    task_id: saved.task_id,
    owner: saved.owner,
    reviewer: saved.reviewer,
    detail: {
      from: previous,
      to: owner,
      reason
    }
  });
  return saved;
}

function recordAttempt(cwd, attempt) {
  validateAttempt(attempt);
  const row = {
    recorded_at: new Date().toISOString(),
    ...attempt
  };
  appendJsonl(paths.attemptsPath(cwd, attempt.task_id), row);
  db.upsertAttempt(cwd, row);
  const task = loadTask(cwd, attempt.task_id);
  recordEvent(cwd, {
    type: "attempt.recorded",
    goal_id: task.goal_id,
    task_id: attempt.task_id,
    owner: attempt.owner,
    status: task.status,
    detail: {
      attempt: attempt.attempt,
      result: attempt.result,
      blocker: attempt.blocker,
      evidence_id: attempt.evidence_id
    }
  });
  return attempt;
}

function attemptsFor(cwd, taskId) {
  return readJsonl(paths.attemptsPath(cwd, taskId));
}

module.exports = {
  init,
  loadConfig,
  listGoals,
  listTasks,
  listRuns,
  saveGoal,
  saveTask,
  saveRun,
  loadGoal,
  loadTask,
  loadRun,
  recordEvent,
  listEvents,
  createGoal,
  updateGoal,
  defaultGoalPrompt,
  createTask,
  createRun,
  completeRun,
  changeOwner,
  recordAttempt,
  attemptsFor
};
