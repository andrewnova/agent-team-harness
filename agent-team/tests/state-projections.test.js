const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const state = require("../src/state");
const paths = require("../src/paths");
const plans = require("../src/plans");
const { regenerate } = require("../src/projections");
const { tempRoot, backendTaskInput, frontendTaskInput } = require("./helpers");

test("ST-1 validates canonical goal and task JSON", () => {
  const cwd = tempRoot();
  const init = state.init(cwd);
  assert.equal(init.config.execution_profile, "turbo_parallel");
  assert.equal(init.config.codex_native_subagents.enabled, true);
  assert.equal(init.config.codex_native_subagents.max_concurrent, 6);
  assert.equal(init.config.claude_agent_teams.enabled, true);
  const goal = state.createGoal(cwd, { title: "Goal", objective: "Build harness" });
  assert.equal(goal.goal_id, "G-000001");
  const task = state.createTask(cwd, backendTaskInput({ goal_id: goal.goal_id }));
  assert.equal(task.task_id, "T-000001");
  assert.match(task.goal_prompt, /Goal: G-000001/);
  assert.match(task.goal_prompt, /Use max useful Codex native subagents/);
});

test("ST-1b migrates config defaults while preserving explicit overrides", () => {
  const cwd = tempRoot();
  const configFile = path.join(paths.rootDir(cwd), "config.json");
  fs.mkdirSync(paths.rootDir(cwd), { recursive: true });
  fs.writeFileSync(
    configFile,
    JSON.stringify(
      {
        version: 1,
        state: "canonical-json",
        execution_profile: "balanced",
        codex_native_subagents: {
          enabled: false,
          max_concurrent: 3
        },
        parallelism_policy: {
          default: "serial_for_debugging"
        },
        bridge_adapters: ["mock"]
      },
      null,
      2
    )
  );
  const init = state.init(cwd);
  assert.equal(init.config.version, 2);
  assert.equal(init.config.state, "sqlite-with-json-mirrors");
  assert.equal(init.config.execution_profile, "balanced");
  assert.equal(init.config.codex_native_subagents.enabled, false);
  assert.equal(init.config.codex_native_subagents.max_concurrent, 3);
  assert.deepEqual(init.config.codex_native_subagents.use_for, ["backend", "tests", "review", "docs", "debugging", "proof_prep"]);
  assert.equal(init.config.claude_agent_teams.enabled, true);
  assert.equal(init.config.parallelism_policy.default, "serial_for_debugging");
  assert.equal(init.config.parallelism_policy.merge_owner, "codex");
  assert.deepEqual(init.config.bridge_adapters, ["mock"]);
  const stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.equal(stored.version, 2);
  assert.equal(stored.state, "sqlite-with-json-mirrors");
  assert.equal(stored.parallelism_policy.proof_owner, "codex");
});

test("FE-1 refuses ready Claude-owned UI task without frontend contract", () => {
  const cwd = tempRoot();
  state.init(cwd);
  assert.throws(
    () => state.createTask(cwd, frontendTaskInput({ frontend_contract: undefined })),
    /frontend_contract/
  );
});

test("FL-1 creates Codex backend and Claude frontend tasks", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const backend = state.createTask(cwd, backendTaskInput());
  const frontend = state.createTask(cwd, frontendTaskInput());
  assert.equal(backend.owner, "codex");
  assert.equal(backend.reviewer, "claude");
  assert.equal(frontend.owner, "claude");
  assert.equal(frontend.reviewer, "codex");
  assert.equal(frontend.tool_permissions.claude_chrome_extension, true);
  assert.equal(frontend.tool_permissions.codex_browser_proof, true);
  assert.equal(backend.tool_permissions.claude_chrome_extension, false);
  assert.equal(backend.acceleration_policy.execution_profile, "turbo_parallel");
  assert.equal(backend.acceleration_policy.codex_subagents, "max_useful_parallelism");
  assert.equal(backend.acceleration_policy.claude_agent_teams, "frontend_only_when_task_is_claude_owned");
  assert.equal(frontend.acceleration_policy.claude_agent_teams, "max_useful_frontend_parallelism");
  assert.equal(frontend.acceleration_policy.codex_final_authority, true);
  assert.match(backend.goal_prompt, /Codex owns this task/);
  assert.match(frontend.goal_prompt, /Claude owns this task/);
});

test("FL-2 rejects invalid acceleration policy overrides", () => {
  const cwd = tempRoot();
  state.init(cwd);
  assert.throws(
    () => state.createTask(cwd, backendTaskInput({ acceleration_policy: { max_codex_subagents: 0 } })),
    /max_codex_subagents/
  );
  assert.throws(
    () => state.createTask(cwd, backendTaskInput({ acceleration_policy: { codex_final_authority: "yes" } })),
    /codex_final_authority/
  );
});

test("RT-1 records owner override reason when owner changes", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput());
  assert.throws(() => state.changeOwner(cwd, task.task_id, "claude"), /owner override reason/);
  const changed = state.changeOwner(cwd, task.task_id, "claude", "Claude is taking the refactor review slice");
  assert.equal(changed.owner, "claude");
  assert.equal(changed.reviewer, "codex");
  assert.equal(changed.owner_history.length, 2);
  assert.equal(changed.owner_history[1].from, "codex");
  assert.equal(changed.owner_history[1].to, "claude");
  assert.match(changed.owner_history[1].reason, /refactor review/);
});

test("EV-1 appends lifecycle events for goals, tasks, ownership, and attempts", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const goal = state.createGoal(cwd, { title: "Goal", objective: "Track work durably" });
  const task = state.createTask(cwd, backendTaskInput({ goal_id: goal.goal_id }));
  state.changeOwner(cwd, task.task_id, "claude", "Claude takes a review-driven slice");
  state.recordAttempt(cwd, {
    task_id: task.task_id,
    attempt: 1,
    owner: "claude",
    hypothesis: "Try the narrow handoff slice",
    changed_files: [],
    commands: [],
    result: "failed",
    blocker: "same error",
    evidence_id: "run-1"
  });
  const events = state.listEvents(cwd, { task_id: task.task_id });
  assert.deepEqual(
    events.map((event) => event.type),
    ["task.created", "owner.changed", "attempt.recorded"]
  );
  assert.equal(events[0].goal_id, goal.goal_id);
  assert.equal(events[1].detail.from, "codex");
  assert.equal(events[2].detail.blocker, "same error");
});

test("RUN-1 records coordination runs in canonical state and health projections", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const goal = state.createGoal(cwd, { title: "Goal", objective: "Track a refactor" });
  const task = state.createTask(cwd, backendTaskInput({ goal_id: goal.goal_id }));
  const run = state.createRun(cwd, {
    kind: "refactor",
    title: "Split channel modules",
    task_id: task.task_id,
    owner: "codex",
    mode: "dev",
    summary: "Refactor the bridge without changing transport behavior."
  });
  assert.equal(run.run_id, "R-000001");
  assert.equal(run.goal_id, goal.goal_id);
  assert.equal(run.status, "active");
  assert.equal(fs.existsSync(paths.runPath(cwd, run.run_id)), true);
  const completed = state.completeRun(cwd, run.run_id, {
    summary: "Refactor passed focused verification.",
    evidence: ["npm test -- --test-name-pattern channel"]
  });
  assert.equal(completed.status, "complete");
  assert.deepEqual(state.listRuns(cwd, { status: "complete" }).map((item) => item.run_id), [run.run_id]);
  const events = state.listEvents(cwd, { goal_id: goal.goal_id }).map((event) => event.type);
  assert.deepEqual(events, ["goal.created", "task.created", "run.started", "run.complete"]);
  const result = regenerate(cwd);
  assert.equal(result.runs, 1);
  const health = fs.readFileSync(paths.healthPath(cwd), "utf8");
  assert.match(health, /Runs: 1/);
  assert.match(health, /Active runs: 0/);
  assert.match(health, /run.complete T-000001 R-000001/);
});

test("PR-1 regenerates board and task markdown from canonical state", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, frontendTaskInput());
  const result = regenerate(cwd);
  assert.equal(result.tasks, 1);
  assert.equal(result.runs, 0);
  assert.equal(result.events, 1);
  assert.match(fs.readFileSync(paths.boardPath(cwd), "utf8"), /Frontend task/);
  assert.match(fs.readFileSync(paths.healthPath(cwd), "utf8"), /Events: 1/);
  assert.match(fs.readFileSync(paths.healthPath(cwd), "utf8"), /task.created/);
  assert.match(fs.readFileSync(paths.taskProjectionPath(cwd, task.task_id), "utf8"), /Frontend Contract/);
  assert.match(fs.readFileSync(paths.taskProjectionPath(cwd, task.task_id), "utf8"), /Goal Prompt/);
  assert.match(fs.readFileSync(paths.taskProjectionPath(cwd, task.task_id), "utf8"), /Goal: G-000001/);
  assert.match(fs.readFileSync(paths.taskProjectionPath(cwd, task.task_id), "utf8"), /Owner History/);
  assert.match(fs.readFileSync(paths.taskProjectionPath(cwd, task.task_id), "utf8"), /Claude browser observation: true/);
  assert.match(fs.readFileSync(paths.taskProjectionPath(cwd, task.task_id), "utf8"), /Execution profile: turbo_parallel/);
  assert.match(fs.readFileSync(paths.taskProjectionPath(cwd, task.task_id), "utf8"), /Claude Agent Teams: max_useful_frontend_parallelism/);
});

test("ST-2 projection edits do not alter canonical truth", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput());
  regenerate(cwd);
  fs.writeFileSync(paths.taskProjectionPath(cwd, task.task_id), "Status: done\n");
  assert.equal(state.loadTask(cwd, task.task_id).status, "ready");
});

test("PL-1 stores Codex, Claude, and reconciled planning artifacts", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const goal = state.createGoal(cwd, { title: "Goal", objective: "Plan before building" });
  const codex = plans.savePlan(cwd, {
    goal_id: goal.goal_id,
    author: "codex",
    body: "Codex proposes backend first and proof gates."
  });
  const claude = plans.savePlan(cwd, {
    goal_id: goal.goal_id,
    author: "claude",
    body: "Claude proposes frontend contract and visual QA."
  });
  const reconciled = plans.reconcilePlan(cwd, {
    goal_id: goal.goal_id,
    body: "Use Codex for backend/proof and Claude for frontend/review."
  });
  assert.equal(fs.existsSync(codex.path), true);
  assert.equal(fs.existsSync(claude.path), true);
  assert.equal(fs.existsSync(reconciled.reconciled_plan), true);
  assert.equal(plans.loadPlanSummary(cwd, goal.goal_id).decision.status, "reconciled");
  regenerate(cwd);
  assert.match(fs.readFileSync(paths.planProjectionPath(cwd, goal.goal_id), "utf8"), /Reconciled plan: true/);
});
