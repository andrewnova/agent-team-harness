const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readJson, readJsonl, writeJson } = require("../src/fsutil");
const paths = require("../src/paths");
const state = require("../src/state");
const { createBridge } = require("../src/bridge");
const { cockpitSnapshot } = require("../src/cockpit");
const { recordReview, requestReview, importReview, loadReview } = require("../src/review");
const { evaluateHandoff } = require("../src/handoff");
const { storeReground, requestReground, importReground } = require("../src/reground");
const { defaultSessionName } = require("../src/bridge/claudeChannel/launcher");
const { tempRoot, backendTaskInput, frontendTaskInput, writeExecutable, withPathEnv } = require("./helpers");

test("MB-1 mock adapter records request and response without live Claude", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const bridge = createBridge("mock");
  const request = bridge.request(cwd, {
    task_id: "T-000001",
    kind: "plan_review",
    prompt: "Review this plan"
  });
  assert.equal(request.result_state, "pending");
  const requests = readJsonl(paths.requestsPath(cwd));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].adapter, "mock");
  assert.equal(readJsonl(paths.responsesPath(cwd)).length, 1);
});

test("CH-3b channel ensure launches a visible Claude teammate through a hermetic launcher", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeClaude = path.join(binDir, "claude");
  const fakeLauncher = path.join(binDir, "launcher");
  writeExecutable(fakeClaude, [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"max\"}'",
    "  exit 0",
    "fi",
    "exit 0"
  ]);
  // Hermetic launcher: run the passed shell command (which writes the launch marker via the
  // real CLI) with the no-op fake claude on PATH; never opens a real Terminal window.
  writeExecutable(fakeLauncher, ["#!/bin/sh", "sh -c \"$1\" >/dev/null 2>&1 &", "exit 0"]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, {
      name: "codex-thread",
      project_dir: cwd,
      visible_launcher: fakeLauncher,
      timeout_ms: 2000,
      poll_ms: 50
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, "started_visible_mcp_pending");
    assert.equal(result.launch_mode, "visible");
    assert.equal(result.start.mode, "visible");
    assert.match(result.start.command.shell, /'--name' 'codex-thread'/);
    assert.match(result.start.command.shell, /'--mcp-config' '/);
    assert.match(result.start.command.shell, /'--channels' 'server:agent-team-claude-launch-/);
    assert.equal(result.start.command.channel_mode, "approved");
    assert.match(result.start.command.mcp_config.server_name, /^agent-team-claude-launch-/);
    const mcpConfig = readJson(result.start.command.mcp_config.path);
    const server = mcpConfig.mcpServers[result.start.command.mcp_config.server_name];
    assert.equal(server.type, "stdio");
    assert.equal(server.command, process.execPath);
    assert.equal(server.env.AGENT_TEAM_LAUNCH_ID, result.launch_id);
    assert.equal(server.env.AGENT_TEAM_SESSION_NAME, "codex-thread");
    assert.equal(server.env.AGENT_TEAM_MCP_SERVER_NAME, result.start.command.mcp_config.server_name);
    assert.equal(fs.realpathSync(server.env.AGENT_TEAM_HARNESS_CWD), fs.realpathSync(cwd));
    assert.equal(readJson(paths.channelSessionPath(cwd)).launch_mode, "visible");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("CH-3d channel ensure uses Codex Terminal launcher when explicitly requested", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeClaude = path.join(binDir, "claude");
  const fakeLauncher = path.join(binDir, "codex-terminal-launcher");
  writeExecutable(fakeClaude, [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"max\"}'",
    "  exit 0",
    "fi",
    "exit 0"
  ]);
  // Hermetic Codex-terminal launcher: runs the launch shell command (writing the real
  // launch marker) with the no-op fake claude; never opens a real terminal.
  writeExecutable(fakeLauncher, ["#!/bin/sh", "sh -c \"$1\" >/dev/null 2>&1 &", "exit 0"]);
  const previousPath = process.env.PATH;
  const previousLauncher = process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER = fakeLauncher;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, {
      name: "codex-thread",
      project_dir: cwd,
      timeout_ms: 2000,
      poll_ms: 50,
      launch_mode: "codex-terminal",
      startup_message: "VISIBLE RECOVERY REQUEST: call reply before finishing."
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, "started_visible_mcp_pending");
    assert.equal(result.launch_mode, "codex-terminal");
    assert.equal(result.start.mode, "codex-terminal");
    assert.equal(result.start.launcher, fakeLauncher);
    assert.match(result.start.command.shell, /'--name' 'codex-thread'/);
    assert.match(result.start.command.shell, /'--mcp-config' '/);
    assert.match(result.start.command.shell, /'--channels' 'server:agent-team-claude-launch-/);
    assert.equal(result.start.command.channel_mode, "approved");
    assert.match(result.start.command.mcp_config.server_name, /^agent-team-claude-launch-/);
    // The injected startup_message reaches the launch command.
    assert.match(result.start.command.shell, /VISIBLE RECOVERY REQUEST/);
  } finally {
    process.env.PATH = previousPath;
    if (previousLauncher === undefined) delete process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER;
    else process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER = previousLauncher;
  }
});

test("CH-3e explicit Codex Terminal launch reports missing launcher with command", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  const fakeClaude = path.join(binDir, "claude");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false}}'",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  echo '{\"targets\":[]}'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  writeExecutable(fakeClaude, [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"max\"}'",
    "  exit 0",
    "fi",
    "exit 0"
  ]);
  const previousPath = process.env.PATH;
  const previousLauncher = process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER;
  process.env.PATH = `${binDir}:${previousPath}`;
  delete process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", timeout_ms: 100, poll_ms: 10, launch_mode: "codex-terminal" });
    assert.equal(result.ok, false);
    assert.equal(result.action, "start_failed");
    assert.equal(result.start.mode, "codex-terminal");
    assert.equal(result.start.reason, "codex_terminal_launcher_missing");
    assert.match(result.start.instructions.join(" "), /Codex Terminal/);
    assert.match(result.start.command.shell, /'--name' 'codex-thread'/);
    assert.equal(result.start.command.channel_mode, "approved");
    assert.equal(JSON.stringify(result).includes(".claude-channel/token"), false);
  } finally {
    process.env.PATH = previousPath;
    if (previousLauncher === undefined) delete process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER;
    else process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER = previousLauncher;
  }
});

test("CH-3h channel ensure reconciles boot ACK that lands during smoke", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  // Fake claude that, when launched, writes a durable boot-ack row keyed to the real
  // launch id (as a real Claude teammate would after reading the boot contract).
  writeExecutable(path.join(binDir, "claude"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"max\"}'",
    "  exit 0",
    "fi",
    "BA=\"$AGENT_TEAM_HARNESS_CWD/.agent-team/comms/claude-channel/boot-acks.jsonl\"",
    "mkdir -p \"$(dirname \"$BA\")\"",
    "printf '{\"launch_id\":\"%s\",\"name\":\"codex-thread\",\"project_dir\":\"%s\",\"harness_cwd\":\"%s\",\"source\":\"claude-boot-ack\",\"pid\":123,\"created_at\":\"2026-06-30T10:00:05.000Z\",\"body\":\"ACK Agent Team quickstart loaded; mailbox is truth.\"}\\n' \"$AGENT_TEAM_LAUNCH_ID\" \"$AGENT_TEAM_HARNESS_CWD\" \"$AGENT_TEAM_HARNESS_CWD\" >> \"$BA\"",
    "exit 0"
  ]);
  // Synchronous launcher: the boot-ack is durably written before the smoke check polls,
  // so the reconciliation is deterministic (no timing race).
  const launcher = path.join(binDir, "launcher");
  writeExecutable(launcher, ["#!/bin/sh", "sh -c \"$1\" >/dev/null 2>&1", "exit 0"]);
  const previousPath = process.env.PATH;
  const previousLauncher = process.env.AGENT_TEAM_VISIBLE_LAUNCHER;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.AGENT_TEAM_VISIBLE_LAUNCHER = launcher;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, {
      name: "codex-thread",
      project_dir: cwd,
      smoke: true,
      smoke_timeout_ms: 500,
      boot_ack_timeout_ms: 0,
      timeout_ms: 500,
      poll_ms: 50
    });
    // The boot-ack the launched Claude wrote is reconciled: delivery is ready and the
    // first-party MCP session is recognized as started.
    assert.equal(result.ok, true);
    assert.equal(result.action, "started_first_party_mcp");
    assert.equal(result.delivery_ready, true);
    assert.equal(result.boot_ack.ok, true);
  } finally {
    process.env.PATH = previousPath;
    if (previousLauncher === undefined) delete process.env.AGENT_TEAM_VISIBLE_LAUNCHER;
    else process.env.AGENT_TEAM_VISIBLE_LAUNCHER = previousLauncher;
  }
});

test("CH-6 channel ensure fails readiness when smoke answer is wrong", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  writeExecutable(path.join(binDir, "claude"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"max\"}'",
    "  exit 0",
    "fi",
    "exit 0"
  ]);
  // Hermetic launcher with a no-op claude that never runs boot-ack, so a --smoke check
  // (which requires a durable boot ACK) must fail readiness rather than falsely pass.
  const launcher = path.join(binDir, "launcher");
  writeExecutable(launcher, ["#!/bin/sh", "sh -c \"$1\" >/dev/null 2>&1 &", "exit 0"]);
  const previousPath = process.env.PATH;
  const previousLauncher = process.env.AGENT_TEAM_VISIBLE_LAUNCHER;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.AGENT_TEAM_VISIBLE_LAUNCHER = launcher;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, {
      name: "codex-thread",
      project_dir: cwd,
      smoke: true,
      smoke_timeout_ms: 800,
      timeout_ms: 800,
      poll_ms: 50
    });
    assert.equal(result.ok, false);
    assert.equal(result.action, "started_boot_ack_missing");
  } finally {
    process.env.PATH = previousPath;
    if (previousLauncher === undefined) delete process.env.AGENT_TEAM_VISIBLE_LAUNCHER;
    else process.env.AGENT_TEAM_VISIBLE_LAUNCHER = previousLauncher;
  }
});

test("CH-7 channel doctor separates auth, channel flag, endpoint, and reply readiness", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  const fakeClaude = path.join(binDir, "claude");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  echo '{\"target\":\"codex-thread\",\"endpoint\":{\"endpoint_id\":\"ep_fake\",\"display_name\":\"codex-thread\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  echo '{\"targets\":[{\"target\":\"ep_fake\",\"endpoint_id\":\"ep_fake\",\"display_name\":\"codex-thread\",\"project_dir\":\"'$PWD'\"}]}'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  writeExecutable(fakeClaude, [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"email\":\"hidden@example.com\",\"subscriptionType\":\"max\"}'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"--dangerously-load-development-channels\" ] || [ \"$1\" = \"--channels\" ] || [ \"$1\" = \"--version\" ]; then",
    "  echo '2.1.195 (Claude Code)'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.diagnose(cwd, { target: "codex-thread" });
    // Doctor still separates readiness concerns; in the first-party MCP model auth is
    // verified via the tri-state probe and reply readiness is mailbox-based, with
    // endpoint status reported as its own field rather than gating on the removed
    // endpoint registry.
    assert.equal(result.claude_auth.logged_in, true);
    assert.equal(result.claude_auth.status, "logged_in");
    assert.equal(result.claude_auth.auth_method, "claude.ai");
    assert.equal(result.claude_auth.email, undefined);
    assert.equal(result.channels_flag.ok, true);
    assert.ok(Object.prototype.hasOwnProperty.call(result, "endpoint_status"));
    assert.equal(result.reply_ready, "mailbox_required");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("CH-8 channel ensure reports Claude auth blocker before launching", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const launchedFile = path.join(cwd, "launched");
  const fakeCli = path.join(binDir, "claude-channel");
  const fakeClaude = path.join(binDir, "claude");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false},\"token_path\":\"/tmp/secret-token\"}'",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  echo '{\"targets\":[]}'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  writeExecutable(fakeClaude, [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":false,\"authMethod\":\"none\",\"apiProvider\":\"firstParty\"}'",
    "  exit 1",
    "fi",
    "touch \"$FAKE_LAUNCHED\"",
    "exit 1"
  ]);
  const previousPath = process.env.PATH;
  const previousLaunched = process.env.FAKE_LAUNCHED;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_LAUNCHED = launchedFile;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", timeout_ms: 100, poll_ms: 10, launch_mode: "background" });
    assert.equal(result.ok, false);
    assert.equal(result.action, "claude_auth_required");
    assert.equal(result.claude_auth.logged_in, false);
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
    assert.equal(fs.existsSync(launchedFile), false);
  } finally {
    process.env.PATH = previousPath;
    if (previousLaunched === undefined) delete process.env.FAKE_LAUNCHED;
    else process.env.FAKE_LAUNCHED = previousLaunched;
  }
});

test("CH-9 keeps channel token paths out of persisted ensure diagnostics", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  const fakeClaude = path.join(binDir, "claude");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false},\"token_path\":\"/home/example/.claude-channel/token\"}'",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  echo '{\"targets\":[]}'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  writeExecutable(fakeClaude, [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo 'auth failed /tmp/secret-token' >&2",
    "  echo '{\"loggedIn\":false,\"authMethod\":\"none\",\"apiProvider\":\"firstParty\"}'",
    "  exit 1",
    "fi",
    "exit 1"
  ]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", timeout_ms: 100, poll_ms: 10, launch_mode: "background" });
    assert.equal(result.action, "claude_auth_required");
    const resultText = JSON.stringify(result);
    const historyText = fs.readFileSync(path.join(cwd, ".agent-team", "comms", "claude-channel", "sessions.jsonl"), "utf8");
    assert.equal(resultText.includes(".claude-channel/token"), false);
    assert.equal(resultText.includes("secret-token"), false);
    assert.equal(historyText.includes(".claude-channel/token"), false);
    assert.equal(historyText.includes("secret-token"), false);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("RV-1 imports Codex-to-Claude review", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput());
  recordReview(cwd, {
    task_id: task.task_id,
    reviewer: "claude",
    owner: "codex",
    verdict: "changes_requested",
    required_fixes: [{ file: "src/api/x.js", issue: "Too broad", fix: "Narrow it" }],
    optional_suggestions: [],
    questions: []
  });
  const review = loadReview(cwd, task.task_id, "claude");
  assert.equal(review.required_fixes.length, 1);
});

test("RV-2 records Claude-to-Codex review for frontend task", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, frontendTaskInput());
  recordReview(cwd, {
    task_id: task.task_id,
    reviewer: "codex",
    owner: "claude",
    verdict: "approve",
    required_fixes: [],
    optional_suggestions: ["Add a visual regression later"],
    questions: []
  });
  assert.equal(loadReview(cwd, task.task_id, "codex").verdict, "approve");
});

test("RV-3 requests and imports a normalized cross-model review response", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput({ status: "review" }));
  const request = requestReview(cwd, task.task_id, { adapter: "mock" });
  const imported = importReview(cwd, task.task_id, { request_id: request.request_id });
  assert.equal(imported.ok, true);
  assert.equal(imported.review.reviewer, "claude");
  assert.equal(imported.review.owner, "codex");
  assert.equal(imported.review.verdict, "approve");
  assert.equal(loadReview(cwd, task.task_id, "claude").verdict, "approve");
});

test("HO-1 hands off after three same-blocker owner failures", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput());
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    state.recordAttempt(cwd, {
      task_id: task.task_id,
      attempt,
      owner: "codex",
      hypothesis: `Try ${attempt}`,
      changed_files: [],
      commands: [],
      result: "failed",
      blocker: "same error",
      evidence_id: `run-${attempt}`
    });
  }
  const result = evaluateHandoff(cwd, task.task_id);
  assert.equal(result.action, "handoff");
  assert.equal(result.task.owner, "claude");
  assert.equal(state.listEvents(cwd, { task_id: task.task_id }).at(-1).type, "task.handoff");
});

test("HO-2 escalates after both models fail same blocker", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput());
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    state.recordAttempt(cwd, {
      task_id: task.task_id,
      attempt,
      owner: "codex",
      hypothesis: `Codex ${attempt}`,
      changed_files: [],
      commands: [],
      result: "failed",
      blocker: "same error",
      evidence_id: `codex-${attempt}`
    });
  }
  evaluateHandoff(cwd, task.task_id);
  for (let attempt = 4; attempt <= 6; attempt += 1) {
    state.recordAttempt(cwd, {
      task_id: task.task_id,
      attempt,
      owner: "claude",
      hypothesis: `Claude ${attempt}`,
      changed_files: [],
      commands: [],
      result: "failed",
      blocker: "same error",
      evidence_id: `claude-${attempt}`
    });
  }
  const result = evaluateHandoff(cwd, task.task_id);
  assert.equal(result.action, "human");
});

test("RG-1 rejects reground packet that contradicts canonical task", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput());
  const result = storeReground(cwd, {
    task_id: task.task_id,
    source: "claude",
    base_tree_hash: "hash",
    restated_objective: "Wrong objective",
    restated_acceptance: task.acceptance_criteria
  });
  assert.equal(result.ok, false);
  assert.equal(result.drift.length, 1);
});

test("RG-2 stores faithful reground packet", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput());
  const result = storeReground(cwd, {
    task_id: task.task_id,
    source: "claude",
    base_tree_hash: "hash",
    restated_objective: task.objective,
    restated_acceptance: task.acceptance_criteria,
    active_tasks_state: [],
    open_decisions: [],
    corrections: [],
    open_questions: []
  });
  assert.equal(result.ok, true);
  assert.equal(state.listEvents(cwd, { task_id: task.task_id }).at(-1).type, "reground.stored");
});

test("RG-3 requests and imports a faithful Claude re-grounding packet through the bridge", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput());
  const request = requestReground(cwd, task.task_id, { adapter: "mock" });
  assert.equal(request.kind, "reground");
  const imported = importReground(cwd, task.task_id, { request_id: request.request_id });
  assert.equal(imported.ok, true);
  assert.equal(imported.packet.restated_objective, task.objective);
  assert.deepEqual(imported.packet.restated_acceptance, task.acceptance_criteria);
  assert.deepEqual(
    state.listEvents(cwd, { task_id: task.task_id }).map((event) => event.type),
    ["task.created", "reground.requested", "reground.stored"]
  );
});
