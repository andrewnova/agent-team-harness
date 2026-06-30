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

test("CH-1 reports unavailable live channel instead of faking a round trip", () => {
  withPathEnv(tempRoot(), () => {
    const bridge = createBridge("claude-channel");
    const status = bridge.status();
    assert.equal(status.ok, false);
    assert.match(status.reason, /Claude channel bridge/);
  }, {}, { replacePath: true });
});

test("CH-1 live adapter uses documented ask-file flow and records failures", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"ask-file\" ]; then",
    "  echo 'No live Claude Code channel endpoints are running.' >&2",
    "  exit 1",
    "fi",
    "exit 0"
  ]);
  state.init(cwd);
  withPathEnv(binDir, () => {
    const bridge = createBridge("claude-channel");
    const request = bridge.request(cwd, {
      task_id: "T-000001",
      kind: "plan_review",
      prompt: "From Codex: review this plan.",
      timeout_ms: 1000
    });
    const requests = readJsonl(paths.requestsPath(cwd));
    const responses = readJsonl(paths.responsesPath(cwd));
    assert.equal(requests[0].adapter, "claude-channel");
    assert.equal(request.response.result_state, "failed");
    assert.equal(responses[0].result_state, "failed");
    assert.match(responses[0].stderr, /No live Claude Code/);
  });
});

test("CH-1b live adapter floors long-form request timeouts to 30 minutes", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const argsFile = path.join(cwd, "claude-args.txt");
  const fakeCli = path.join(binDir, "claude-channel");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
    "if [ \"$1\" = \"ask-file\" ]; then",
    "  echo '{\"request_id\":\"req_fake\",\"target\":\"ep_fake\",\"status\":\"answered\",\"answer\":\"ok\"}'",
    "  exit 0",
    "fi",
    "exit 0"
  ]);
  state.init(cwd);
  withPathEnv(binDir, () => {
    const bridge = createBridge("claude-channel");
    const request = bridge.request(cwd, {
      task_id: "G-000001",
      kind: "plan_review",
      prompt: "From Codex: review this plan.",
      timeout_ms: 1000
    });
    const args = fs.readFileSync(argsFile, "utf8").trim().split(/\r?\n/);
    assert.equal(request.response.result_state, "answered");
    assert.equal(args[0], "ask-file");
    assert.deepEqual(args.slice(args.indexOf("--timeout-ms"), args.indexOf("--timeout-ms") + 2), [
      "--timeout-ms",
      "1800000"
    ]);
  });
});

test("CH-1c live adapter keeps long-form timeout responses recoverable", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"ask-file\" ]; then",
    "  echo 'HTTP 504: timed out waiting for Claude Code reply' >&2",
    "  exit 1",
    "fi",
    "exit 0"
  ]);
  state.init(cwd);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const bridge = createBridge("claude-channel");
    const request = bridge.request(cwd, {
      task_id: "G-000001",
      kind: "plan_review",
      prompt: "From Codex: review this plan.",
      timeout_ms: 1000
    });
    const responses = readJsonl(paths.responsesPath(cwd));
    assert.equal(request.response.result_state, "timeout_pending");
    assert.equal(request.response.timeout_ms, 1800000);
    assert.equal(responses[0].result_state, "timeout_pending");
    assert.match(responses[0].note, /durable mailbox request is still authoritative/);
    assert.doesNotMatch(responses[0].note, /complete_channel_request/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("CH-1c timeout-pending live replies remain visible in cockpit queues", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"ask-file\" ]; then",
    "  echo 'timed out waiting for Claude Code reply' >&2",
    "  exit 1",
    "fi",
    "exit 0"
  ]);
  state.init(cwd);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const bridge = createBridge("claude-channel");
    const request = bridge.request(cwd, {
      task_id: "T-000001",
      kind: "plan_review",
      prompt: "From Codex: review this plan.",
      timeout_ms: 1000
    });
    assert.equal(request.response.result_state, "timeout_pending");
    const snapshot = cockpitSnapshot(cwd, { live_channel: false });
    assert.equal(snapshot.claude_channel.queues.requests, 1);
    assert.equal(snapshot.claude_channel.queues.responses, 1);
    assert.equal(snapshot.claude_channel.queues.timeout_pending, 1);
    assert.equal(snapshot.claude_channel.queues.pending.length, 1);
    assert.equal(snapshot.claude_channel.queues.pending[0].request_id, request.request_id);
    assert.equal(snapshot.claude_channel.queues.pending[0].response_state, "timeout_pending");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("CH-2 channel ensure reuses a reachable named Claude session", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  echo '{\"target\":\"codex-thread\",\"endpoint\":{\"endpoint_id\":\"ep_fake\",\"display_name\":\"codex-thread\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", timeout_ms: 100, poll_ms: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.action, "reused");
    assert.equal(result.name, "codex-thread");
    assert.equal(readJson(paths.channelSessionPath(cwd)).action, "reused");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("CH-2b channel status rejects non-json success output", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  writeExecutable(fakeCli, ["#!/bin/sh", "echo 'ready'", "exit 0"]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.status("codex-thread", cwd);
    assert.equal(result.ok, false);
    assert.equal(result.exit_code, 0);
    assert.equal(result.parsed, null);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("CH-2c default Claude session name is Codex-thread scoped and avoids unrelated same-project reuse", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const readyFile = path.join(cwd, "ready");
  const fakeCli = path.join(binDir, "claude-channel");
  const fakeClaude = path.join(binDir, "claude");
  const threadId = "019f0fc3-3dd8-75c0-b15c-09fcb96bd921";
  const expectedName = defaultSessionName(cwd, { CODEX_THREAD_ID: threadId });
  assert.match(expectedName, /^codex-.+-019f0fc3-3d/);
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ -f \"$FAKE_READY\" ] && { [ \"$3\" = \"$FAKE_EXPECTED_NAME\" ] || [ \"$3\" = \"ep_thread\" ]; }; then",
    "    echo '{\"target\":\"ep_thread\",\"endpoint\":{\"endpoint_id\":\"ep_thread\",\"display_name\":\"'$FAKE_EXPECTED_NAME'\",\"project_dir\":\"'$PWD'\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false}}'",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  if [ -f \"$FAKE_READY\" ]; then",
    "    echo '{\"targets\":[{\"target\":\"ep_thread\",\"endpoint_id\":\"ep_thread\",\"display_name\":\"'$FAKE_EXPECTED_NAME'\",\"project_dir\":\"'$PWD'\",\"started_at\":\"2026-06-28T00:00:02.000Z\"}]}'",
    "  else",
    "    echo '{\"targets\":[{\"target\":\"ep_old\",\"endpoint_id\":\"ep_old\",\"display_name\":\"codex-old-thread\",\"project_dir\":\"'$PWD'\",\"started_at\":\"2026-06-28T00:00:01.000Z\"}]}'",
    "  fi",
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
    "touch \"$FAKE_READY\"",
    "echo 'backgrounded - fake123 - '$FAKE_EXPECTED_NAME",
    "exit 0"
  ]);
  const previousPath = process.env.PATH;
  const previousReady = process.env.FAKE_READY;
  const previousExpected = process.env.FAKE_EXPECTED_NAME;
  const previousThread = process.env.CODEX_THREAD_ID;
  const previousName = process.env.AGENT_TEAM_CLAUDE_NAME;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_READY = readyFile;
  process.env.FAKE_EXPECTED_NAME = expectedName;
  process.env.CODEX_THREAD_ID = threadId;
  delete process.env.AGENT_TEAM_CLAUDE_NAME;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { timeout_ms: 1000, poll_ms: 10, launch_mode: "background" });
    assert.equal(result.ok, true);
    assert.equal(result.action, "started");
    assert.equal(result.name, expectedName);
    assert.equal(result.session_identity.thread_ref, "019f0fc3-3dd");
    assert.equal(result.session_identity.strict_project_reuse, true);
    assert.equal(result.skipped_reuse, null);
    assert.equal(result.background.name, expectedName);
    assert.equal(result.endpoint.display_name, expectedName);
    const session = readJson(paths.channelSessionPath(cwd));
    assert.equal(session.session_identity.thread_ref, "019f0fc3-3dd");
    assert.equal(session.session_identity.strict_project_reuse, true);
    assert.equal(session.identity_confidence, "launched_new_endpoint");
  } finally {
    process.env.PATH = previousPath;
    if (previousReady === undefined) delete process.env.FAKE_READY;
    else process.env.FAKE_READY = previousReady;
    if (previousExpected === undefined) delete process.env.FAKE_EXPECTED_NAME;
    else process.env.FAKE_EXPECTED_NAME = previousExpected;
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
    if (previousName === undefined) delete process.env.AGENT_TEAM_CLAUDE_NAME;
    else process.env.AGENT_TEAM_CLAUDE_NAME = previousName;
  }
});

test("CH-2d channel ensure reuses prior same-thread endpoint id before display-name fallback", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  const threadId = "019f0fc3-3dd8-75c0-b15c-09fcb96bd921";
  const expectedName = defaultSessionName(cwd, { CODEX_THREAD_ID: threadId });
  writeJson(paths.channelSessionPath(cwd), {
    ok: true,
    action: "started",
    name: expectedName,
    target: "ep_remembered",
    project_dir: fs.realpathSync.native(cwd),
    session_identity: {
      source: "CODEX_THREAD_ID",
      thread_ref: "019f0fc3-3dd",
      strict_project_reuse: true
    },
    endpoint: {
      target: "ep_remembered",
      display_name: expectedName,
      project_dir: fs.realpathSync.native(cwd)
    }
  });
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ \"$3\" = \"$FAKE_EXPECTED_NAME\" ]; then",
    "    echo '{\"target\":\"ep_wrong\",\"endpoint\":{\"endpoint_id\":\"ep_wrong\",\"display_name\":\"'$FAKE_EXPECTED_NAME'\",\"project_dir\":\"'$PWD'\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  if [ \"$3\" = \"ep_remembered\" ]; then",
    "    echo '{\"target\":\"ep_remembered\",\"endpoint\":{\"endpoint_id\":\"ep_remembered\",\"display_name\":\"'$FAKE_EXPECTED_NAME'\",\"project_dir\":\"'$PWD'\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  if [ \"$3\" = \"ep_wrong\" ]; then",
    "    echo '{\"target\":\"ep_wrong\",\"endpoint\":{\"endpoint_id\":\"ep_wrong\",\"display_name\":\"'$FAKE_EXPECTED_NAME'\",\"project_dir\":\"'$PWD'\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  echo '{\"targets\":[{\"target\":\"ep_wrong\",\"endpoint_id\":\"ep_wrong\",\"display_name\":\"'$FAKE_EXPECTED_NAME'\",\"project_dir\":\"'$PWD'\",\"started_at\":\"2026-06-28T00:00:03.000Z\"},{\"target\":\"ep_remembered\",\"endpoint_id\":\"ep_remembered\",\"display_name\":\"'$FAKE_EXPECTED_NAME'\",\"project_dir\":\"'$PWD'\",\"started_at\":\"2026-06-28T00:00:01.000Z\"}]}'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  const previousPath = process.env.PATH;
  const previousThread = process.env.CODEX_THREAD_ID;
  const previousExpected = process.env.FAKE_EXPECTED_NAME;
  const previousName = process.env.AGENT_TEAM_CLAUDE_NAME;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.CODEX_THREAD_ID = threadId;
  process.env.FAKE_EXPECTED_NAME = expectedName;
  delete process.env.AGENT_TEAM_CLAUDE_NAME;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { timeout_ms: 1000, poll_ms: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.action, "reused_project_endpoint");
    assert.equal(result.target, "ep_remembered");
    assert.equal(result.reuse_source, "remembered_endpoint_id");
    assert.equal(result.identity_confidence, "remembered_endpoint_id_reused");
    assert.equal(result.remembered_endpoint.ok, true);
    assert.equal(result.remembered_endpoint.target, "ep_remembered");
  } finally {
    process.env.PATH = previousPath;
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
    if (previousExpected === undefined) delete process.env.FAKE_EXPECTED_NAME;
    else process.env.FAKE_EXPECTED_NAME = previousExpected;
    if (previousName === undefined) delete process.env.AGENT_TEAM_CLAUDE_NAME;
    else process.env.AGENT_TEAM_CLAUDE_NAME = previousName;
  }
});

test("CH-2e channel ensure handles empty display-name status before remembered endpoint reuse", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  const threadId = "019f0fc3-3dd8-75c0-b15c-09fcb96bd921";
  const expectedName = defaultSessionName(cwd, { CODEX_THREAD_ID: threadId });
  writeJson(paths.channelSessionPath(cwd), {
    ok: true,
    action: "started",
    name: expectedName,
    target: "ep_remembered",
    project_dir: fs.realpathSync.native(cwd),
    session_identity: {
      source: "CODEX_THREAD_ID",
      thread_ref: "019f0fc3-3dd",
      strict_project_reuse: true
    },
    endpoint: {
      target: "ep_remembered",
      display_name: expectedName,
      project_dir: fs.realpathSync.native(cwd)
    }
  });
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ \"$3\" = \"$FAKE_EXPECTED_NAME\" ]; then",
    "    echo '{\"reachable\":false,\"health\":{\"ok\":false}}'",
    "    exit 1",
    "  fi",
    "  if [ \"$3\" = \"ep_remembered\" ]; then",
    "    echo '{\"target\":\"ep_remembered\",\"endpoint\":{\"endpoint_id\":\"ep_remembered\",\"display_name\":\"'$FAKE_EXPECTED_NAME'\",\"project_dir\":\"'$PWD'\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  echo '{\"targets\":[{\"target\":\"ep_remembered\",\"endpoint_id\":\"ep_remembered\",\"display_name\":\"'$FAKE_EXPECTED_NAME'\",\"project_dir\":\"'$PWD'\",\"started_at\":\"2026-06-28T00:00:01.000Z\"}]}'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  const previousPath = process.env.PATH;
  const previousThread = process.env.CODEX_THREAD_ID;
  const previousExpected = process.env.FAKE_EXPECTED_NAME;
  const previousName = process.env.AGENT_TEAM_CLAUDE_NAME;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.CODEX_THREAD_ID = threadId;
  process.env.FAKE_EXPECTED_NAME = expectedName;
  delete process.env.AGENT_TEAM_CLAUDE_NAME;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { timeout_ms: 1000, poll_ms: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.target, "ep_remembered");
    assert.equal(result.reuse_source, "remembered_endpoint_id");
    assert.equal(result.identity_confidence, "remembered_endpoint_id_reused");
  } finally {
    process.env.PATH = previousPath;
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
    if (previousExpected === undefined) delete process.env.FAKE_EXPECTED_NAME;
    else process.env.FAKE_EXPECTED_NAME = previousExpected;
    if (previousName === undefined) delete process.env.AGENT_TEAM_CLAUDE_NAME;
    else process.env.AGENT_TEAM_CLAUDE_NAME = previousName;
  }
});

test("CH-3 channel ensure starts Claude background session and waits for endpoint", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const readyFile = path.join(cwd, "ready");
  const fakeCli = path.join(binDir, "claude-channel");
  const fakeClaude = path.join(binDir, "claude");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ -f \"$FAKE_READY\" ]; then",
    "    echo '{\"target\":\"codex-thread\",\"endpoint\":{\"endpoint_id\":\"ep_fake\",\"display_name\":\"codex-thread\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false}}'",
    "  exit 1",
    "fi",
    "exit 1"
  ]);
  writeExecutable(fakeClaude, [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"max\"}'",
    "  exit 0",
    "fi",
    "touch \"$FAKE_READY\"",
    "echo 'backgrounded - fake123 - codex-thread'",
    "exit 0"
  ]);
  const previousPath = process.env.PATH;
  const previousReady = process.env.FAKE_READY;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_READY = readyFile;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", timeout_ms: 1000, poll_ms: 10, launch_mode: "background" });
    assert.equal(result.ok, true);
    assert.equal(result.action, "started");
    assert.equal(result.background.id, "fake123");
    const session = readJson(paths.channelSessionPath(cwd));
    assert.equal(session.name, "codex-thread");
    assert.equal(session.command.env.CLAUDE_CHANNEL_DISPLAY_NAME, "codex-thread");
  } finally {
    process.env.PATH = previousPath;
    if (previousReady === undefined) {
      delete process.env.FAKE_READY;
    } else {
      process.env.FAKE_READY = previousReady;
    }
  }
});

test("CH-3b channel ensure defaults to a visible Claude teammate launch", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const readyFile = path.join(cwd, "ready");
  const fakeCli = path.join(binDir, "claude-channel");
  const fakeClaude = path.join(binDir, "claude");
  const fakeOsascript = path.join(binDir, "osascript");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ -f \"$FAKE_READY\" ]; then",
    "    echo '{\"target\":\"codex-thread\",\"endpoint\":{\"endpoint_id\":\"ep_fake\",\"display_name\":\"codex-thread\",\"project_dir\":\"'$PWD'\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false}}'",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  if [ -f \"$FAKE_READY\" ]; then",
    "    echo '{\"targets\":[{\"target\":\"ep_fake\",\"endpoint_id\":\"ep_fake\",\"display_name\":\"codex-thread\",\"project_dir\":\"'$PWD'\"}]}'",
    "  else",
    "    echo '{\"targets\":[]}'",
    "  fi",
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
  writeExecutable(fakeOsascript, ["#!/bin/sh", "touch \"$FAKE_READY\"", "echo visible-window-opened", "exit 0"]);
  const previousPath = process.env.PATH;
  const previousReady = process.env.FAKE_READY;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_READY = readyFile;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", timeout_ms: 1000, poll_ms: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.action, "started");
    assert.equal(result.launch_mode, "visible");
    assert.equal(result.start.mode, "visible");
    assert.match(result.start.command.shell, /'--name' 'codex-thread'/);
    assert.match(result.start.command.shell, /'--dangerously-load-development-channels' 'server:claude-channel-cli'/);
    assert.equal(result.start.command.channel_mode, "development");
    assert.equal(readJson(paths.channelSessionPath(cwd)).launch_mode, "visible");
  } finally {
    process.env.PATH = previousPath;
    if (previousReady === undefined) delete process.env.FAKE_READY;
    else process.env.FAKE_READY = previousReady;
  }
});

test("CH-3f channel ensure fresh visible launch fails with endpoint probe when no new endpoint appears", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const launchFile = path.join(cwd, "visible-launched");
  const fakeCli = path.join(binDir, "claude-channel");
  const fakeClaude = path.join(binDir, "claude");
  const fakeOsascript = path.join(binDir, "osascript");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  echo '{\"target\":\"ep_old\",\"endpoint\":{\"endpoint_id\":\"ep_old\",\"display_name\":\"old-thread\",\"project_dir\":\"'$PWD'\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  echo '{\"targets\":[{\"target\":\"ep_old\",\"endpoint_id\":\"ep_old\",\"display_name\":\"old-thread\",\"project_dir\":\"'$PWD'\",\"started_at\":\"2026-06-28T00:00:01.000Z\"}]}'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"rename\" ]; then",
    "  echo 'rename should not be called for failed fresh visible launch' >&2",
    "  exit 12",
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
  writeExecutable(fakeOsascript, ["#!/bin/sh", "touch \"$FAKE_LAUNCH_FILE\"", "echo visible-window-opened", "exit 0"]);
  const previousPath = process.env.PATH;
  const previousLaunchFile = process.env.FAKE_LAUNCH_FILE;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_LAUNCH_FILE = launchFile;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, {
      name: "fresh-thread",
      fresh_claude: true,
      timeout_ms: 100,
      poll_ms: 10,
      launch_mode: "visible"
    });
    assert.equal(fs.existsSync(launchFile), true);
    assert.equal(result.ok, false);
    assert.equal(result.action, "fresh_start_no_new_endpoint");
    assert.equal(result.launch_mode, "visible");
    assert.equal(result.start.mode, "visible");
    assert.equal(result.identity_confidence, "fresh_launch_unverified_no_new_endpoint");
    assert.equal(result.discovered.reason, "no_new_endpoint_after_fresh_launch");
    assert.equal(result.discovered.probe.require_new, true);
    assert.equal(result.discovered.probe.before_project_count, 1);
    assert.equal(result.discovered.probe.after_project_count, 1);
    assert.equal(result.discovered.probe.new_project_count, 0);
    assert.equal(result.discovered.probe.existing_project_targets[0].target, "ep_old");
    assert.equal(result.fresh_launch_probe.new_project_count, 0);
    assert.equal(result.rename, undefined);
  } finally {
    process.env.PATH = previousPath;
    if (previousLaunchFile === undefined) delete process.env.FAKE_LAUNCH_FILE;
    else process.env.FAKE_LAUNCH_FILE = previousLaunchFile;
  }
});

test("CH-3g channel ensure records visible launch marker when endpoint registry stays stale", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const commandFile = path.join(cwd, "visible-command.txt");
  const fakeCli = path.join(binDir, "claude-channel");
  const fakeClaude = path.join(binDir, "claude");
  const fakeLauncher = path.join(binDir, "visible-launcher");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  echo '{\"target\":\"ep_old\",\"endpoint\":{\"endpoint_id\":\"ep_old\",\"display_name\":\"old-thread\",\"project_dir\":\"'$PWD'\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  echo '{\"targets\":[{\"target\":\"ep_old\",\"endpoint_id\":\"ep_old\",\"display_name\":\"old-thread\",\"project_dir\":\"'$PWD'\",\"started_at\":\"2026-06-28T00:00:01.000Z\"}]}'",
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
  writeExecutable(fakeLauncher, [
    "#!/bin/sh",
    "printf '%s\\n' \"$1\" > \"$FAKE_COMMAND_FILE\"",
    "sh -c \"$1\"",
    "exit $?"
  ]);
  const previousPath = process.env.PATH;
  const previousCommandFile = process.env.FAKE_COMMAND_FILE;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_COMMAND_FILE = commandFile;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, {
      name: "fresh-thread",
      fresh_claude: true,
      timeout_ms: 100,
      poll_ms: 10,
      launch_mode: "visible",
      visible_launcher: fakeLauncher,
      launch_marker_timeout_ms: 1000
    });
    assert.equal(result.ok, false);
    assert.equal(result.action, "fresh_start_no_new_endpoint");
    assert.equal(result.launch_marker.ok, true);
    assert.equal(result.launch_marker.record.launch_id, result.launch_id);
    assert.equal(result.launch_marker.record.name, "fresh-thread");
    assert.equal(result.launch_marker.record.mode, "visible");
    assert.equal(result.boot_ack.ok, false);
    assert.match(fs.readFileSync(commandFile, "utf8"), /channel launch-marker/);
    const markers = readJsonl(paths.channelLaunchMarkersPath(cwd));
    assert.equal(markers.length, 1);
    assert.equal(markers[0].launch_id, result.launch_id);
    assert.equal(fs.realpathSync(markers[0].project_dir), fs.realpathSync(cwd));
  } finally {
    process.env.PATH = previousPath;
    if (previousCommandFile === undefined) delete process.env.FAKE_COMMAND_FILE;
    else process.env.FAKE_COMMAND_FILE = previousCommandFile;
  }
});

test("CH-3d channel ensure prefers Codex Terminal launcher when configured", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const readyFile = path.join(cwd, "ready");
  const commandFile = path.join(cwd, "codex-terminal-command.txt");
  const fakeCli = path.join(binDir, "claude-channel");
  const fakeClaude = path.join(binDir, "claude");
  const fakeLauncher = path.join(binDir, "codex-terminal-launcher");
  fs.mkdirSync(paths.rootDir(cwd), { recursive: true });
  fs.writeFileSync(
    path.join(paths.rootDir(cwd), "teammate-quickstart.md"),
    ["# Claude Teammate Quickstart", "", "- The durable mailbox is the communication truth."].join("\n")
  );
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ -f \"$FAKE_READY\" ]; then",
    "    echo '{\"target\":\"codex-thread\",\"endpoint\":{\"endpoint_id\":\"ep_fake\",\"display_name\":\"codex-thread\",\"project_dir\":\"'$PWD'\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false}}'",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  if [ -f \"$FAKE_READY\" ]; then",
    "    echo '{\"targets\":[{\"target\":\"ep_fake\",\"endpoint_id\":\"ep_fake\",\"display_name\":\"codex-thread\",\"project_dir\":\"'$PWD'\"}]}'",
    "  else",
    "    echo '{\"targets\":[]}'",
    "  fi",
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
  writeExecutable(fakeLauncher, [
    "#!/bin/sh",
    "printf '%s\\n' \"$1\" > \"$FAKE_COMMAND\"",
    "touch \"$FAKE_READY\"",
    "echo codex-terminal-opened",
    "exit 0"
  ]);
  const previousPath = process.env.PATH;
  const previousReady = process.env.FAKE_READY;
  const previousCommand = process.env.FAKE_COMMAND;
  const previousLauncher = process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_READY = readyFile;
  process.env.FAKE_COMMAND = commandFile;
  process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER = fakeLauncher;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", timeout_ms: 1000, poll_ms: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.action, "started");
    assert.equal(result.launch_mode, "codex-terminal");
    assert.equal(result.start.mode, "codex-terminal");
    assert.equal(result.start.launcher, fakeLauncher);
    assert.match(result.start.command.shell, /'--name' 'codex-thread'/);
    assert.match(result.start.command.shell, /'--dangerously-load-development-channels' 'server:claude-channel-cli'/);
    const launchedCommand = fs.readFileSync(commandFile, "utf8");
    assert.match(launchedCommand, /complete_channel_request/);
    assert.match(launchedCommand, /Harness root:/);
    assert.match(launchedCommand, /\.agent-team\/teammate-quickstart\.md/);
    assert.match(launchedCommand, /# Claude Teammate Quickstart/);
    assert.match(launchedCommand, /ACK Agent Team quickstart loaded; mailbox is truth/);
    assert.match(launchedCommand, /--cwd/);
    assert.match(launchedCommand, /mailbox send-batch --json <file>/);
    assert.match(launchedCommand, /Do not hand-roll shell loops/);
    assert.match(launchedCommand, /self-heal recommendation/);
    assert.equal(readJson(paths.channelSessionPath(cwd)).launch_mode, "codex-terminal");
  } finally {
    process.env.PATH = previousPath;
    if (previousReady === undefined) delete process.env.FAKE_READY;
    else process.env.FAKE_READY = previousReady;
    if (previousCommand === undefined) delete process.env.FAKE_COMMAND;
    else process.env.FAKE_COMMAND = previousCommand;
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
    assert.equal(result.start.command.channel_mode, "development");
    assert.equal(JSON.stringify(result).includes(".claude-channel/token"), false);
  } finally {
    process.env.PATH = previousPath;
    if (previousLauncher === undefined) delete process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER;
    else process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER = previousLauncher;
  }
});

test("CH-4 channel ensure renames a started endpoint to the Codex session name", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const readyFile = path.join(cwd, "ready");
  const renamedFile = path.join(cwd, "renamed");
  const fakeCli = path.join(binDir, "claude-channel");
  const fakeClaude = path.join(binDir, "claude");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"list\" ]; then",
    "  if [ -f \"$FAKE_READY\" ]; then",
    `    echo '{"targets":[{"target":"ep_new","endpoint_id":"ep_new","display_name":"agent-team-review","project_dir":"${cwd}","started_at":"2026-06-28T00:00:01.000Z"}]}'`,
    "    exit 0",
    "  fi",
    "  echo '{\"targets\":[]}'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ \"$3\" = \"ep_new\" ] && [ -f \"$FAKE_READY\" ]; then",
    "    echo '{\"target\":\"ep_new\",\"endpoint\":{\"endpoint_id\":\"ep_new\",\"display_name\":\"agent-team-review\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  if [ \"$3\" = \"codex-thread\" ] && [ -f \"$FAKE_RENAMED\" ]; then",
    "    echo '{\"target\":\"ep_new\",\"endpoint\":{\"endpoint_id\":\"ep_new\",\"display_name\":\"codex-thread\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false}}'",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"rename\" ]; then",
    "  touch \"$FAKE_RENAMED\"",
    "  echo 'Renamed ep_new to codex-thread'",
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
    "touch \"$FAKE_READY\"",
    "echo 'backgrounded - fake123 - codex-thread'",
    "exit 0"
  ]);
  const previousPath = process.env.PATH;
  const previousReady = process.env.FAKE_READY;
  const previousRenamed = process.env.FAKE_RENAMED;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_READY = readyFile;
  process.env.FAKE_RENAMED = renamedFile;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", timeout_ms: 1000, poll_ms: 10, launch_mode: "background" });
    assert.equal(result.ok, true);
    assert.equal(result.action, "started");
    assert.equal(result.rename.ok, true);
    assert.equal(fs.existsSync(renamedFile), true);
  } finally {
    process.env.PATH = previousPath;
    if (previousReady === undefined) delete process.env.FAKE_READY;
    else process.env.FAKE_READY = previousReady;
    if (previousRenamed === undefined) delete process.env.FAKE_RENAMED;
    else process.env.FAKE_RENAMED = previousRenamed;
  }
});

test("CH-5 channel ensure renames an existing project endpoint before launching", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const renamedFile = path.join(cwd, "renamed");
  const fakeCli = path.join(binDir, "claude-channel");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"list\" ]; then",
    `  echo '{"targets":[{"target":"ep_old","endpoint_id":"ep_old","display_name":"agent-team-review","project_dir":"${cwd}","started_at":"2026-06-28T00:00:01.000Z"}]}'`,
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ \"$3\" = \"ep_old\" ]; then",
    "    echo '{\"target\":\"ep_old\",\"endpoint\":{\"endpoint_id\":\"ep_old\",\"display_name\":\"agent-team-review\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  if [ \"$3\" = \"codex-thread\" ] && [ -f \"$FAKE_RENAMED\" ]; then",
    "    echo '{\"target\":\"ep_old\",\"endpoint\":{\"endpoint_id\":\"ep_old\",\"display_name\":\"codex-thread\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"rename\" ]; then",
    "  touch \"$FAKE_RENAMED\"",
    "  echo 'Renamed ep_old to codex-thread'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  const previousPath = process.env.PATH;
  const previousRenamed = process.env.FAKE_RENAMED;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_RENAMED = renamedFile;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", timeout_ms: 1000, poll_ms: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.action, "renamed_reused");
    assert.equal(result.rename.ok, true);
    assert.equal(fs.existsSync(renamedFile), true);
  } finally {
    process.env.PATH = previousPath;
    if (previousRenamed === undefined) delete process.env.FAKE_RENAMED;
    else process.env.FAKE_RENAMED = previousRenamed;
  }
});

test("CH-5b channel ensure uses endpoint id when duplicate display names are present", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"list\" ]; then",
    `  echo '{"targets":[{"target":"ep_old","endpoint_id":"ep_old","display_name":"codex-thread","project_dir":"${cwd}","started_at":"2026-06-28T00:00:01.000Z"},{"target":"ep_latest","endpoint_id":"ep_latest","display_name":"codex-thread","project_dir":"${cwd}","started_at":"2026-06-28T00:00:02.000Z"}]}'`,
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ \"$3\" = \"codex-thread\" ]; then",
    "    echo 'Multiple Claude Code channel endpoints are running. Specify a target' >&2",
    "    exit 1",
    "  fi",
    "  if [ \"$3\" = \"ep_latest\" ]; then",
    "    echo '{\"target\":\"ep_latest\",\"endpoint\":{\"endpoint_id\":\"ep_latest\",\"display_name\":\"codex-thread\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false}}'",
    "  exit 1",
    "fi",
    "exit 1"
  ]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", timeout_ms: 1000, poll_ms: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.action, "reused_project_endpoint");
    assert.equal(result.target, "ep_latest");
    assert.equal(result.status.target, "ep_latest");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("CH-5d channel ensure refuses to reuse a same-name endpoint from another project", () => {
  const cwd = tempRoot();
  const projectDir = tempRoot();
  const otherDir = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    `  echo '{"target":"codex-thread","endpoint":{"endpoint_id":"ep_wrong","display_name":"codex-thread","project_dir":"${otherDir}"},"reachable":true,"health":{"ok":true}}'`,
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    `  echo '{"targets":[{"target":"ep_wrong","endpoint_id":"ep_wrong","display_name":"codex-thread","project_dir":"${otherDir}","started_at":"2026-06-28T00:00:01.000Z"}]}'`,
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  const previousPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", project_dir: projectDir, timeout_ms: 100, poll_ms: 10 });
    assert.equal(result.ok, false);
    assert.notEqual(result.action, "reused");
    assert.equal(result.action, "missing_claude_cli");
    assert.equal(result.project_dir, fs.realpathSync.native(projectDir));
    assert.equal(result.harness_cwd, path.resolve(cwd));
    assert.equal(result.workspace_mismatch.expected_project_dir, fs.realpathSync.native(projectDir));
    assert.equal(result.workspace_mismatch.actual_project_dir, fs.realpathSync.native(otherDir));
  } finally {
    process.env.PATH = previousPath;
  }
});

test("CH-5e channel ensure allows cross-project reuse only with explicit opt-in", () => {
  const cwd = tempRoot();
  const projectDir = tempRoot();
  const otherDir = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    `  echo '{"target":"codex-thread","endpoint":{"endpoint_id":"ep_wrong","display_name":"codex-thread","project_dir":"${otherDir}"},"reachable":true,"health":{"ok":true}}'`,
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, {
      name: "codex-thread",
      project_dir: projectDir,
      allow_cross_project_reuse: true,
      timeout_ms: 100,
      poll_ms: 10
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, "reused");
    assert.equal(result.cross_project_reuse_allowed, true);
    assert.equal(result.workspace_mismatch.actual_project_dir, fs.realpathSync.native(otherDir));
  } finally {
    process.env.PATH = previousPath;
  }
});

test("CH-5c channel ensure recovers late duplicate endpoints by endpoint id", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const countFile = path.join(cwd, "list-count");
  const fakeCli = path.join(binDir, "claude-channel");
  const fakeClaude = path.join(binDir, "claude");
  const fakeOsascript = path.join(binDir, "osascript");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"list\" ]; then",
    "  COUNT=0",
    "  if [ -f \"$FAKE_COUNT\" ]; then COUNT=$(cat \"$FAKE_COUNT\"); fi",
    "  COUNT=$((COUNT + 1))",
    "  echo \"$COUNT\" > \"$FAKE_COUNT\"",
    "  if [ \"$COUNT\" -ge 3 ]; then",
    `    echo '{"targets":[{"target":"ep_old","endpoint_id":"ep_old","display_name":"codex-thread","project_dir":"${cwd}","started_at":"2026-06-28T00:00:01.000Z"},{"target":"ep_late","endpoint_id":"ep_late","display_name":"codex-thread","project_dir":"${cwd}","started_at":"2026-06-28T00:00:02.000Z"}]}'`,
    "  else",
    "    echo '{\"targets\":[]}'",
    "  fi",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ \"$3\" = \"codex-thread\" ]; then",
    "    echo 'Multiple Claude Code channel endpoints are running. Specify a target' >&2",
    "    exit 1",
    "  fi",
    "  if [ \"$3\" = \"ep_late\" ]; then",
    "    echo '{\"target\":\"ep_late\",\"endpoint\":{\"endpoint_id\":\"ep_late\",\"display_name\":\"codex-thread\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false}}'",
    "  exit 1",
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
  writeExecutable(fakeOsascript, ["#!/bin/sh", "echo visible-window-opened", "exit 0"]);
  const previousPath = process.env.PATH;
  const previousCount = process.env.FAKE_COUNT;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_COUNT = countFile;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", timeout_ms: 1, poll_ms: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.action, "started_recovered_endpoint");
    assert.equal(result.target, "ep_late");
    assert.equal(result.recovered_endpoint.target, "ep_late");
  } finally {
    process.env.PATH = previousPath;
    if (previousCount === undefined) delete process.env.FAKE_COUNT;
    else process.env.FAKE_COUNT = previousCount;
  }
});

test("CH-6 channel ensure fails readiness when smoke answer is wrong", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const fakeCli = path.join(binDir, "claude-channel");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  echo '{\"target\":\"codex-thread\",\"endpoint\":{\"endpoint_id\":\"ep_fake\",\"display_name\":\"codex-thread\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"ask\" ]; then",
    "  echo '{\"request_id\":\"req_fake\",\"target\":\"ep_fake\",\"status\":\"answered\",\"answer\":\"wrong\"}'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const bridge = createBridge("claude-channel");
    const result = bridge.ensure(cwd, { name: "codex-thread", smoke: true, smoke_timeout_ms: 1000 });
    assert.equal(result.ok, false);
    assert.equal(result.action, "reused_smoke_failed");
    assert.equal(result.reply_ready, false);
  } finally {
    process.env.PATH = previousPath;
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
    assert.equal(result.ok, true);
    assert.equal(result.claude_auth.logged_in, true);
    assert.equal(result.claude_auth.auth_method, "claude.ai");
    assert.equal(result.claude_auth.email, undefined);
    assert.equal(result.channels_flag.ok, true);
    assert.equal(result.endpoint_status.ok, true);
    assert.equal(result.reply_ready, "unchecked");
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
