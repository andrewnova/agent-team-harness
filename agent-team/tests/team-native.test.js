const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempRoot } = require("./helpers");
const jobs = require("../src/team/jobs");
const native = require("../src/team/native");
const features = require("../src/team/features");
const { encodeFrame, decodeFrames } = require("../src/mcp/claudeServer");

const ADDRESS = {
  workspace_id: "11111111-1111-4111-8111-111111111111",
  surface_id: "22222222-2222-4222-8222-222222222222"
};

function fixture(t) {
  const temporary = fs.realpathSync(tempRoot());
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "coordinator with spaces");
  const cwd = path.join(temporary, "assigned checkout");
  fs.mkdirSync(root);
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(root, ".agent-team", "state"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent-team", "state", "cmux-project.json"), JSON.stringify(ADDRESS));
  const create = (id, input = {}) => jobs.createJob(root, {
    id, leader: "codex", role: "backend", model: "explicit-test-model", cwd,
    writable: false, prompt: "Read the assigned source.", ...input
  });
  const start = (id, input) => {
    create(id, input);
    return jobs.claimJob(root, id, { max_active: 16 });
  };
  return { temporary, root, cwd, create, start };
}

function launchData(command) {
  assert.equal(command.argv[0], process.execPath);
  assert.equal(command.argv[1], require.resolve("../src/team/sessionRunner"));
  assert.equal(command.argv.length, 3);
  assert.equal(command.argv[2], path.join(command.directory, "launch.json"));
  return JSON.parse(fs.readFileSync(command.argv[2], "utf8"));
}

function option(argv, name) {
  const index = argv.indexOf(name);
  assert.notEqual(index, -1, `missing option ${name}`);
  return argv[index + 1];
}

function mcpConfig(launch) {
  if (launch.argv[0] === "claude-fixture-only") {
    return JSON.parse(fs.readFileSync(option(launch.argv, "--mcp-config"), "utf8")).mcpServers.agent_team;
  }
  const overrides = launch.argv.flatMap((arg, i) => arg === "-c" ? [launch.argv[i + 1]] : []);
  const read = (key) => JSON.parse(overrides.find((entry) => entry.startsWith(`${key}=`)).slice(key.length + 1));
  assert.equal(read("mcp_servers.agent_team.required"), true);
  return { command: read("mcp_servers.agent_team.command"), args: read("mcp_servers.agent_team.args") };
}

for (const leader of ["codex", "claude"]) {
  for (const [role, writable] of [["lead", true], ["backend", true], ["frontend", true], ["review", false]]) {
    test(`native command uses explicit ${leader}-led ${role} routing and interactive permissions`, (t) => {
      const f = fixture(t);
      const prompt = "Inspect 'quoted paths'; preserve $HOME and `literal text`.\n--dangerously-skip-permissions is assignment text.";
      const first = f.start("assigned-job", { leader, role, writable, model: `${leader}-${role}-model`, prompt });
      jobs.finishJob(f.root, first.id, first.attempt, { status: "failed", process_stopped: true });
      const job = jobs.claimJob(f.root, first.id, { max_active: 1 });
      const expectedRuntime = role === "lead" ? leader : role === "review" ? (leader === "codex" ? "claude" : "codex") : role === "frontend" ? "claude" : "codex";
      const command = native.buildNativeCommand(f.root, job, { codex_bin: "codex-fixture-only", claude_bin: "claude-fixture-only" });
      const launch = launchData(command);
      assert.equal(job.runtime, expectedRuntime);
      assert.equal(launch.argv[0], `${expectedRuntime}-fixture-only`);
      assert.equal(option(launch.argv, "--model"), `${leader}-${role}-model`);
      assert.equal(launch.root, f.root);
      assert.equal(launch.cwd, f.cwd);
      assert.equal(launch.job_id, job.id);
      assert.equal(launch.attempt, 2);
      assert.equal(command.directory, path.join(f.root, ".agent-team", "sessions", job.id, "2"));
      assert.equal(fs.statSync(command.argv[2]).mode & 0o777, 0o600);
      const separator = launch.argv.indexOf("--");
      assert.equal(separator, launch.argv.length - 2, "assignment must be a single positional argument");
      const flags = launch.argv.slice(1, separator);
      for (const forbidden of ["exec", "-p", "--print", "--headless", "--yolo", "--full-auto", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"]) {
        assert.equal(flags.includes(forbidden), false, `unexpected native flag ${forbidden}`);
      }
      assert.ok(launch.argv.at(-1).endsWith(prompt));
      assert.match(launch.argv.at(-1), /team_report.*ready/);
      assert.match(launch.argv.at(-1), /team_inbox/);
      assert.deepEqual(mcpConfig(launch), {
        command: process.execPath,
        args: [require.resolve("../src/team/sessionMcp"), "--cwd", f.root, "--job", job.id, "--attempt", "2"],
        ...(expectedRuntime === "claude" ? { alwaysLoad: true } : {})
      });
      if (expectedRuntime === "codex") {
        assert.equal(option(flags, "-C"), f.cwd);
        assert.equal(option(flags, "--sandbox"), writable ? "workspace-write" : "read-only");
        assert.equal(option(flags, "--ask-for-approval"), "on-request");
        assert.ok(flags.includes("--no-alt-screen"));
        assert.ok(flags.includes("features.multi_agent=true"));
        assert.ok(flags.includes('model_reasoning_effort="xhigh"'));
        assert.ok(flags.includes("features.multi_agent_v2.enabled=true"));
        assert.ok(flags.includes("features.multi_agent_v2.expose_spawn_agent_model_overrides=false"));
        assert.ok(flags.includes("features.step_model_switching=false"));
        assert.ok(flags.includes(`agents.default_subagent_model=${JSON.stringify(job.model)}`));
        assert.ok(flags.includes('agents.default_subagent_reasoning_effort="xhigh"'));
        const childConfig = path.join(command.directory, "codex-child.toml");
        for (const childRole of ["default", "worker", "explorer"]) assert.ok(flags.includes(`agents.${childRole}.config_file=${JSON.stringify(childConfig)}`));
        const child = fs.readFileSync(childConfig, "utf8");
        assert.ok(child.includes(`model = ${JSON.stringify(job.model)}`));
        assert.match(child, /model_reasoning_effort = "xhigh"/);
        assert.match(child, /parent alone may use the harness/);
        assert.equal(fs.statSync(childConfig).mode & 0o777, 0o600);
        assert.equal(launch.session_id, undefined, "Codex identity must come from the actual session");
      } else {
        if (writable) assert.equal(flags.includes("--permission-mode"), false);
        else assert.equal(option(flags, "--permission-mode"), "dontAsk");
        const settings = JSON.parse(option(flags, "--settings"));
        assert.equal(option(flags, "--effort"), "medium");
        assert.equal(settings.switchModelsOnFlag, false);
        assert.equal(settings.teammateMode, "in-process");
        assert.deepEqual(settings.env, {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
          CLAUDE_CODE_EFFORT_LEVEL: "medium",
          CLAUDE_CODE_SUBAGENT_MODEL: job.model,
          CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1"
        });
        const guard = settings.hooks.PreToolUse[0].hooks[0];
        assert.equal(guard.command, process.execPath);
        assert.deepEqual(guard.args, [require.resolve("../src/team/claudeAgentGuard"), command.directory, launch.session_id, writable ? "write" : "read"]);
        assert.ok(flags.includes("Agent"));
        assert.equal(flags.includes("--disallowedTools"), false);
        assert.ok(flags.includes("--strict-mcp-config"));
        assert.match(launch.session_id, /^[0-9a-f-]{36}$/);
        assert.equal(option(flags, "--session-id"), launch.session_id);
        for (const tool of ["team_inbox", "team_send", "team_reply", "team_report"]) assert.ok(flags.includes(`mcp__agent_team__${tool}`));
        if (!writable) {
          const exposed = option(flags, "--tools").split(",");
          for (const tool of ["Read", "Glob", "Grep", "Agent", "SendMessage"]) assert.ok(exposed.includes(tool));
          for (const tool of ["Bash", "Write", "Edit"]) assert.equal(exposed.includes(tool), false);
        }
        assert.equal(fs.statSync(option(flags, "--mcp-config")).mode & 0o777, 0o600);
      }
    });
  }
}

test("native artifacts cannot be overwritten and a retry receives a distinct MCP binding", (t) => {
  const f = fixture(t);
  const first = f.start("review", { role: "review" });
  const command = native.buildNativeCommand(f.root, first, { claude_bin: "claude-fixture-only" });
  const original = fs.readFileSync(command.argv[2], "utf8");
  assert.throws(() => native.buildNativeCommand(f.root, first), { code: "EEXIST" });
  assert.equal(fs.readFileSync(command.argv[2], "utf8"), original);
  jobs.finishJob(f.root, first.id, 1, { status: "failed", process_stopped: true });
  const next = jobs.claimJob(f.root, first.id, { max_active: 1 });
  const retry = native.buildNativeCommand(f.root, next, { claude_bin: "claude-fixture-only" });
  assert.notEqual(retry.directory, command.directory);
  assert.notEqual(launchData(retry).session_id, launchData(command).session_id);
  assert.equal(mcpConfig(launchData(retry)).args.at(-1), "2");
  assert.equal(fs.readFileSync(command.argv[2], "utf8"), original);
});

test("launch binds only the allocated surface and requires an independent ready report", (t) => {
  const f = fixture(t);
  f.create("writer", { writable: true });
  const createSession = t.mock.fn((request) => {
    assert.equal(request.cwd, f.cwd);
    assert.match(request.title, /writer.*codex/);
    assert.equal(launchData(request.command).job_id, "writer");
    return { ...ADDRESS, ready: true, status: "running" };
  });
  const job = native.launchJob(f.root, "writer", { max_active: 1, transport: { createSession, readSession: (target) => ({ ...target, text: "controller" }) } });
  assert.equal(createSession.mock.callCount(), 1);
  assert.equal(job.status, "launching");
  assert.equal(job.ready_at, undefined);
  assert.equal(job.process_stopped, false);
  assert.equal(job.workspace_id, ADDRESS.workspace_id);
  assert.equal(job.surface_id, ADDRESS.surface_id);
  assert.equal(jobs.reportJob(f.root, job.id, job.attempt, { status: "ready" }).status, "running");
});

for (const failure of ["allocation", "binding"]) {
  test(`${failure} failure retains the writer claim and records uncertain launch evidence`, (t) => {
    const f = fixture(t);
    f.create("writer", { writable: true });
    f.create("next", { writable: true });
    const allocationError = Object.assign(new Error("fixture allocation response lost"), { session: ADDRESS, launch_uncertain: true });
    const createSession = t.mock.fn(() => {
      if (failure === "allocation") throw allocationError;
      // The runner can bind before workspace.create returns a conflicting response.
      jobs.bindJob(f.root, "writer", 1, ADDRESS);
      return { ...ADDRESS, surface_id: "33333333-3333-4333-8333-333333333333" };
    });
    assert.throws(() => native.launchJob(f.root, "writer", { max_active: 2, transport: { createSession, readSession: (target) => ({ ...target, text: "controller" }) } }),
      failure === "allocation" ? /allocation response lost/ : /already bound/);
    assert.equal(createSession.mock.callCount(), 1);
    const job = jobs.getJob(f.root, "writer");
    assert.equal(job.status, "launching");
    assert.equal(job.process_stopped, false);
    assert.throws(() => jobs.claimJob(f.root, "next", { max_active: 2 }), /writer/);
    assert.throws(() => jobs.claimJob(f.root, "next", { max_active: 1 }), /capacity/);
    const evidence = JSON.parse(fs.readFileSync(path.join(f.root, ".agent-team", "sessions", "writer", "1", "launch-error.json"), "utf8"));
    assert.equal(evidence.claim_retained, true);
    if (failure === "allocation") assert.deepEqual(evidence.session, ADDRESS);
    else assert.equal(job.surface_id, ADDRESS.surface_id);
  });
}

test("pre-launch configuration error proves no process started and releases the claim", (t) => {
  const f = fixture(t);
  f.create("writer", { writable: true });
  f.create("next", { writable: true });
  const directory = path.join(f.root, ".agent-team", "sessions", "writer", "1");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "launch.json"), "existing launch evidence");
  const createSession = t.mock.fn(() => assert.fail("transport must not run after configuration failure"));
  assert.throws(() => native.launchJob(f.root, "writer", { max_active: 1, transport: { createSession } }), { code: "EEXIST" });
  assert.equal(createSession.mock.callCount(), 0);
  const job = jobs.getJob(f.root, "writer");
  assert.equal(job.status, "failed");
  assert.equal(job.process_stopped, true);
  assert.match(job.result, /EEXIST/);
  assert.equal(fs.readFileSync(path.join(directory, "launch.json"), "utf8"), "existing launch evidence");
  assert.equal(jobs.claimJob(f.root, "next", { max_active: 1 }).status, "launching");
});

for (const phase of ["controller", "session preflight"]) {
  test(`${phase} failure releases a job that never reached native allocation`, (t) => {
    const f = fixture(t);
    f.create("writer", { writable: true });
    f.create("next", { writable: true });
    const transport = {
      readSession: (target) => {
        if (phase === "controller") throw Object.assign(new Error("controller allocation outcome unknown"), { launch_uncertain: true });
        return { ...target, text: "controller" };
      },
      createSession: () => { throw new Error("session pane validation failed before allocation"); }
    };
    assert.throws(() => native.launchJob(f.root, "writer", { max_active: 1, transport }));
    const failed = jobs.getJob(f.root, "writer");
    assert.equal(failed.status, "failed");
    assert.equal(failed.process_stopped, true);
    assert.equal(jobs.claimJob(f.root, "next", { max_active: 1 }).status, "launching");
    const receipt = JSON.parse(fs.readFileSync(path.join(f.root, ".agent-team/sessions/writer/1/launch-error.json")));
    assert.equal(receipt.claim_retained, false);
  });
}

test("health distinguishes readiness, stalled startup, missing terminals and cleanup without changing ownership", (t) => {
  const f = fixture(t);
  const job = f.start("worker");
  const transport = { readSession: (target) => ({ ...target, text: "native terminal" }) };
  assert.equal(native.jobHealth(f.root, job, { transport }).state, "starting");
  const future = Date.parse(job.updated_at) + 120001;
  assert.equal(native.jobHealth(f.root, job, { transport, now_ms: future }).state, "blocked");
  assert.equal(jobs.getJob(f.root, job.id).process_stopped, false);
  jobs.bindJob(f.root, job.id, 1, ADDRESS);
  jobs.reportJob(f.root, job.id, 1, { status: "ready" });
  assert.equal(native.jobHealth(f.root, job.id, { transport }).ready, true);
  const missing = { readSession() { throw new Error("terminal missing"); } };
  assert.equal(native.jobHealth(f.root, job.id, { transport: missing }).state, "blocked");
  jobs.reportJob(f.root, job.id, 1, { status: "completed", result: "done" });
  assert.equal(native.jobHealth(f.root, job.id, { transport }).state, "stopping");
  assert.equal(jobs.getJob(f.root, job.id).status, "running");
});

test("health never treats a dead or reused supervising process as a ready native job", (t) => {
  const f = fixture(t);
  f.start("worker");
  const identity = { pid: 123456789, started: "original-start" };
  jobs.claimRunner(f.root, "worker", 1, identity.pid, identity);
  jobs.bindJob(f.root, "worker", 1, ADDRESS);
  jobs.reportJob(f.root, "worker", 1, { status: "ready" });
  const options = { transport: { readSession: (target) => ({ ...target, text: "retained terminal" }) } };
  assert.equal(native.jobHealth(f.root, "worker", { ...options, read_processes: () => [identity] }).ready, true);
  for (const rows of [[], [{ ...identity, started: "unrelated-reused-pid" }]]) {
    const health = native.jobHealth(f.root, "worker", { ...options, read_processes: () => rows });
    assert.equal(health.ready, false);
    assert.equal(health.state, "blocked");
  }
  assert.equal(native.jobHealth(f.root, "worker", { ...options, read_processes() { throw new Error("inventory unavailable"); } }).state, "blocked");
  assert.equal(jobs.getJob(f.root, "worker").process_stopped, false);
});

function nativeHealthFixture(t) {
  const f = fixture(t);
  f.start("worker", { writable: true });
  f.create("next", { writable: true });
  const runner = { pid: 123456789, parent: 1, group: 123456789, started: "runner-start" };
  const child = { pid: 123456790, parent: runner.pid, group: 123456790, started: "native-start" };
  jobs.claimRunner(f.root, "worker", 1, runner.pid, runner);
  jobs.bindJob(f.root, "worker", 1, { ...ADDRESS, pid: child.pid });
  const job = jobs.reportJob(f.root, "worker", 1, { status: "ready" });
  const directory = native.attemptDirectory(f.root, job);
  const options = {
    transport: { readSession: (target) => ({ ...target, text: "retained native terminal" }) },
    read_processes: () => [runner, child]
  };
  assert.equal(native.jobHealth(f.root, job.id, options).ready, true, "control has a verified runner and its live native child");
  const assertOwnership = () => {
    assert.deepEqual(jobs.getJob(f.root, job.id), job, "health must not mutate the persisted job");
    assert.throws(() => jobs.claimJob(f.root, "next", { max_active: 2 }), /writer/, "health must retain checkout ownership");
  };
  const writeExit = (process_stopped) => fs.writeFileSync(path.join(directory, "exit.json"), JSON.stringify({
    job_id: job.id, attempt: job.attempt, runner_pid: runner.pid, pid: child.pid,
    code: 0, signal: null, process_stopped, observed_processes: [child],
    remaining: process_stopped ? [] : [child], stopped_at: new Date().toISOString()
  }));
  return { ...f, job, runner, child, directory, options, assertOwnership, writeExit };
}

for (const process_stopped of [true, false]) {
  test(`health rejects a retained ready session with exit.json process_stopped=${process_stopped}`, (t) => {
    const f = nativeHealthFixture(t);
    f.writeExit(process_stopped);
    const health = native.jobHealth(f.root, f.job.id, f.options);
    assert.equal(health.ready, false);
    assert.ok(["stopping", "blocked"].includes(health.state), health.state);
    assert.match(health.note, /exit/i);
    f.assertOwnership();
  });
}

for (const state of ["missing", "reparented"]) {
  test(`health blocks a ${state} native child despite a verified live runner and retained terminal`, (t) => {
    const f = nativeHealthFixture(t);
    const rows = state === "missing" ? [f.runner] : [f.runner, { ...f.child, parent: 1 }];
    const health = native.jobHealth(f.root, f.job.id, { ...f.options, read_processes: () => rows });
    assert.equal(health.ready, false);
    assert.equal(health.state, "blocked");
    assert.match(health.note, /native|child|process|pid/i);
    f.assertOwnership();
  });
}

for (const file of ["exit.json", "launch-error.json", "mcp-error.json"]) {
  for (const failure of ["corrupt", "malformed error", "inaccessible", "directory", "dangling symlink"]) {
    test(`health visibly blocks ${failure} ${file} after ready without throwing`, (t) => {
      const f = nativeHealthFixture(t);
      const evidence = path.join(f.directory, file);
      if (failure === "directory") fs.mkdirSync(evidence);
      else if (failure === "dangling symlink") fs.symlinkSync(path.join(f.directory, "missing-receipt.json"), evidence);
      else if (failure === "malformed error") fs.writeFileSync(evidence, JSON.stringify({ error: { toString: null }, process_stopped: true }));
      else fs.writeFileSync(evidence, failure === "corrupt" ? "{broken" : JSON.stringify({ error: "fixture failure" }));
      if (failure === "inaccessible") {
        const read = fs.readFileSync;
        t.mock.method(fs, "readFileSync", function (target, ...args) {
          if (target === evidence) throw Object.assign(new Error("fixture evidence access denied"), { code: "EACCES" });
          return read.call(this, target, ...args);
        });
      }
      let health;
      assert.doesNotThrow(() => { health = native.jobHealth(f.root, f.job.id, f.options); });
      assert.equal(health.ready, false);
      assert.equal(health.state, "blocked");
      assert.ok(health.note.includes(file), `diagnostic must identify ${file}: ${health.note}`);
      f.assertOwnership();
    });
  }
}

test("health blocks an mcp-error.json written after the native job reported ready", (t) => {
  const f = nativeHealthFixture(t);
  fs.writeFileSync(path.join(f.directory, "mcp-error.json"), JSON.stringify({ error: "fixture MCP disconnected" }));
  const health = native.jobHealth(f.root, f.job.id, f.options);
  assert.equal(health.ready, false);
  assert.equal(health.state, "blocked");
  assert.match(health.note, /mcp-error\.json/);
  f.assertOwnership();
});

for (const evidence of ["stopped exit", "unstopped exit", "missing child"]) {
  test(`bounded wait until ready rejects a retained session with ${evidence}`, { timeout: 2000 }, async (t) => {
    const f = nativeHealthFixture(t);
    if (evidence !== "missing child") f.writeExit(evidence === "stopped exit");
    t.mock.method(require("../src/team/processes"), "inventory", () =>
      evidence === "missing child" ? [f.runner] : [f.runner, f.child]);
    const result = await native.waitForJob(f.root, f.job.id, {
      until: "ready", timeout_ms: 10, transport: f.options.transport
    });
    assert.equal(result.reached, false);
    assert.equal(result.until, "ready");
    assert.equal(result.health.ready, false);
    assert.ok(["stopping", "blocked"].includes(result.health.state), result.health.state);
    f.assertOwnership();
  });
}

test("bounded wait observes semantic readiness and stopped evidence without cancelling timed-out jobs", async (t) => {
  const f = fixture(t);
  f.start("worker");
  const transport = { readSession: (target) => ({ ...target, text: "native terminal" }) };
  const pending = await native.waitForJob(f.root, "worker", { until: "ready", timeout_ms: 1, transport });
  assert.equal(pending.reached, false);
  assert.equal(jobs.getJob(f.root, "worker").status, "launching");
  jobs.bindJob(f.root, "worker", 1, ADDRESS);
  jobs.reportJob(f.root, "worker", 1, { status: "ready" });
  assert.equal((await native.waitForJob(f.root, "worker", { until: "ready", transport })).reached, true);
  jobs.cancelJob(f.root, "worker", 1);
  const finish = setTimeout(() => jobs.finishJob(f.root, "worker", 1, { status: "cancelled", process_stopped: true }), 20);
  t.after(() => clearTimeout(finish));
  const stopped = await native.waitForJob(f.root, "worker", { until: "stopped", timeout_ms: 1000, transport });
  assert.equal(stopped.reached, true);
  assert.equal(stopped.job.status, "cancelled");
});

test("a bounded wait cannot silently follow a replacement attempt", async (t) => {
  const f = fixture(t);
  f.start("worker");
  const replace = setTimeout(() => {
    jobs.finishJob(f.root, "worker", 1, { status: "failed", process_stopped: true });
    jobs.claimJob(f.root, "worker", { max_active: 1 });
  }, 20);
  t.after(() => clearTimeout(replace));
  const result = await native.waitForJob(f.root, "worker", { until: "stopped", timeout_ms: 1000 });
  assert.equal(result.reached, false);
  assert.match(result.note, /attempt changed/);
  assert.equal(jobs.getJob(f.root, "worker").attempt, 2);
});

test("claim rejection creates no launch artifacts and never reaches the transport", (t) => {
  const f = fixture(t);
  f.create("worker");
  const createSession = t.mock.fn(() => assert.fail("invalid capacity cannot launch"));
  assert.throws(() => native.launchJob(f.root, "worker", { max_active: 0, transport: { createSession } }), /max_active/);
  assert.equal(jobs.getJob(f.root, "worker").attempt, 0);
  assert.equal(createSession.mock.callCount(), 0);
  assert.equal(fs.existsSync(path.join(f.root, ".agent-team", "sessions")), false);
});

test("addressed wake waits for readiness and submits only to the recipient's exact surface", (t) => {
  const f = fixture(t);
  f.start("sender");
  f.start("recipient");
  f.start("sibling");
  const message = jobs.sendJobMessage(f.root, { from_job: "sender", to_job: "recipient", body: "Private assignment must remain in the inbox" });
  const sendText = t.mock.fn((request) => ({ ...ADDRESS, submitted: request.submit, semantic_reply_confirmed: true }));
  const transport = { sendText };
  assert.deepEqual(native.wakeMessage(f.root, message, transport), { status: "pending", reason: "recipient_not_ready" });
  jobs.bindJob(f.root, "recipient", 1, ADDRESS);
  assert.equal(native.wakeMessage(f.root, message, transport).status, "pending");
  assert.equal(sendText.mock.callCount(), 0);
  jobs.reportJob(f.root, "recipient", 1, { status: "ready" });
  const receipt = native.wakeMessage(f.root, message, transport);
  assert.equal(sendText.mock.callCount(), 1);
  const request = sendText.mock.calls[0].arguments[0];
  assert.equal(request.workspace_id, ADDRESS.workspace_id);
  assert.equal(request.surface_id, ADDRESS.surface_id);
  assert.equal(request.submit, true);
  assert.ok(request.text.includes(message.id));
  assert.match(request.text, /team_inbox/);
  assert.equal(request.text.includes("Private assignment"), false);
  assert.equal(receipt.status, "submitted");
  assert.equal(receipt.semantic_reply_confirmed, false);
  assert.deepEqual(jobs.jobInbox(f.root, "sibling", 1), []);
  assert.equal(jobs.jobInbox(f.root, "recipient", 1)[0].id, message.id);
  jobs.cancelJob(f.root, "recipient", 1);
  assert.equal(native.wakeMessage(f.root, message, transport).status, "pending");
  assert.equal(sendText.mock.callCount(), 1);
});

test("stale-attempt wakes cannot target a retry even after the new surface is ready", (t) => {
  const f = fixture(t);
  f.start("sender");
  f.start("recipient");
  const message = jobs.sendJobMessage(f.root, { from_job: "sender", to_job: "recipient", body: "Old attempt" });
  jobs.finishJob(f.root, "recipient", 1, { status: "failed", process_stopped: true });
  jobs.claimJob(f.root, "recipient", { max_active: 2 });
  jobs.bindJob(f.root, "recipient", 2, { ...ADDRESS, ready: true });
  const sendText = t.mock.fn(() => assert.fail("stale wake cannot submit to retry"));
  assert.throws(() => native.wakeMessage(f.root, message, { sendText }), /stale/);
  assert.equal(sendText.mock.callCount(), 0);
  assert.deepEqual(jobs.jobInbox(f.root, "recipient", 2), []);
});

test("a wake transport error remains visible and preserves the durable message", (t) => {
  const f = fixture(t);
  f.start("sender");
  f.start("recipient");
  jobs.bindJob(f.root, "recipient", 1, { ...ADDRESS, ready: true });
  const message = jobs.sendJobMessage(f.root, { from_job: "sender", to_job: "recipient", body: "Read after recovery" });
  const error = new Error("fixture surface unavailable");
  assert.throws(() => native.wakeMessage(f.root, message, { sendText: () => { throw error; } }), (actual) => actual === error);
  assert.equal(jobs.jobInbox(f.root, "recipient", 1)[0].body, "Read after recovery");
});

function reviewFixture(t, leader = "codex") {
  const f = fixture(t);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: f.cwd, env, encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Keep native review fixtures isolated");
  const feature = features.createFeature(f.root, {
    id: "feature", repo: f.cwd, brief: "Review this candidate", leader,
    review_jobs: ["review"], checks: [{ id: "unit", command: [process.execPath, "--version"] }]
  });
  const { candidate } = features.snapshotFeature(f.root, feature.id);
  const result = { candidate, brief_hash: candidate.brief_hash, verdict: "approve", findings: [] };
  const startReview = (input = {}) => f.start("review", { leader, role: "review", feature_id: feature.id, cwd: feature.cwd, ...input });
  const complete = (payload = result, attempt = 1) => {
    jobs.reportJob(f.root, "review", attempt, { status: "completed", result: JSON.stringify(payload) });
    return jobs.finishJob(f.root, "review", attempt, { status: "completed", process_stopped: true });
  };
  return { ...f, feature, result, startReview, complete };
}

test("review launch includes the frozen integrated diff and prior findings, and refuses changed source", (t) => {
  const f = reviewFixture(t);
  const job = f.startReview({ cwd: f.cwd });
  const command = native.buildNativeCommand(f.root, job, { claude_bin: "claude-fixture-only" });
  const launch = launchData(command);
  assert.match(launch.argv.at(-1), /Frozen candidate:/);
  assert.ok(launch.argv.at(-1).includes(f.result.candidate.commit));
  assert.ok(fs.existsSync(path.join(command.directory, "candidate.diff")));
  assert.deepEqual(launch.argv.flatMap((flag, index) => flag === "--add-dir" ? [launch.argv[index + 1]] : []), [command.directory, f.feature.cwd]);
  assert.equal(option(launch.argv, "--permission-mode"), "dontAsk");
  assert.equal(option(launch.argv, "--tools").split(",").includes("Write"), false);
  jobs.finishJob(f.root, job.id, 1, { status: "failed", process_stopped: true });
  const retry = jobs.claimJob(f.root, job.id, { max_active: 1 });
  fs.writeFileSync(path.join(f.feature.cwd, "unreviewed.txt"), "new source");
  assert.throws(() => native.buildNativeCommand(f.root, retry), /clean/);
});

test("acceptance cannot reuse an earlier approval while the same candidate is being re-reviewed", (t) => {
  const f = reviewFixture(t);
  f.startReview();
  f.complete();
  native.importReview(f.root, f.feature.id, "review");
  features.runFeatureChecks(f.root, f.feature.id);
  assert.equal(native.acceptanceStatus(f.root, f.feature.id).eligible, true);
  jobs.claimJob(f.root, "review", { max_active: 1 });
  const current = native.acceptanceStatus(f.root, f.feature.id);
  assert.equal(current.eligible, false);
  assert.ok(current.reasons.some((reason) => reason.includes("current stopped evidence")));
});

for (const leader of ["codex", "claude"]) {
  test(`native ${leader}-led review imports only the current stopped opposite-runtime result`, (t) => {
    const f = reviewFixture(t, leader);
    const job = f.startReview();
    assert.equal(job.runtime, leader === "codex" ? "claude" : "codex");
    const payload = { ...f.result, reviewer_job_id: "spoofed", attempt: 99 };
    jobs.reportJob(f.root, "review", 1, { status: "completed", result: JSON.stringify(payload) });
    assert.throws(() => native.importReview(f.root, f.feature.id, "review"), /completed current native attempt/);
    assert.deepEqual(features.getFeature(f.root, f.feature.id).reviews, []);
    jobs.finishJob(f.root, "review", 1, { status: "completed", process_stopped: true });
    const review = native.importReview(f.root, f.feature.id, "review");
    assert.equal(review.reviewer_job_id, "review");
    assert.equal(review.attempt, 1);
    assert.deepEqual(review.candidate, f.result.candidate);
    assert.equal(review.verdict, "approve");
    assert.deepEqual(features.getFeature(f.root, f.feature.id).reviews, [review]);
  });
}

test("native review import rejects wrong role, writable jobs, leader mismatch and feature mismatch", (t) => {
  const f = reviewFixture(t);
  f.startReview();
  f.complete();
  const current = jobs.getJob(f.root, "review");
  const file = path.join(f.root, ".agent-team", "state", "jobs", "review.json");
  // Corrupt persisted bindings independently: creation-time routing validation
  // must not be the only guard when importing durable job results.
  for (const change of [{ role: "backend" }, { writable: true }, { leader: "claude" }, { runtime: "codex" }, { feature_id: "other-feature" }, { feature_id: undefined }]) {
    fs.writeFileSync(file, JSON.stringify({ ...current, ...change }));
    assert.throws(() => native.importReview(f.root, f.feature.id, "review"), /read-only.*opposite leader runtime/);
    assert.deepEqual(features.getFeature(f.root, f.feature.id).reviews, []);
  }
});

test("native review import cannot reuse an earlier attempt's completed report", (t) => {
  const f = reviewFixture(t);
  f.startReview();
  jobs.reportJob(f.root, "review", 1, { status: "completed", result: JSON.stringify(f.result) });
  jobs.finishJob(f.root, "review", 1, { status: "failed", process_stopped: true });
  const retry = jobs.claimJob(f.root, "review", { max_active: 1 });
  assert.equal(retry.previous_attempts[0].reported_result.status, "completed");
  assert.equal(retry.reported_result, undefined);
  assert.throws(() => native.importReview(f.root, f.feature.id, "review"), /completed current native attempt/);
  jobs.finishJob(f.root, "review", 2, { status: "completed", process_stopped: true });
  assert.throws(() => native.importReview(f.root, f.feature.id, "review"), /completed current native attempt/);
  assert.deepEqual(features.getFeature(f.root, f.feature.id).reviews, []);
});

test("a completed review can start a new round, but import requires a fresh current-attempt report", (t) => {
  const f = reviewFixture(t);
  f.startReview();
  f.complete();
  const first = native.importReview(f.root, f.feature.id, "review");
  const second = jobs.claimJob(f.root, "review", { max_active: 1 });
  assert.equal(second.attempt, 2);
  assert.equal(second.previous_attempts[0].status, "completed");
  assert.equal(second.reported_result, undefined);
  assert.throws(() => native.importReview(f.root, f.feature.id, "review"), /completed current native attempt/);
  assert.deepEqual(features.getFeature(f.root, f.feature.id).reviews, [first]);
  const changed = { ...f.result, verdict: "changes_requested", findings: [{ id: "missing-proof", required: true, evidence: "The declared behavior has no regression evidence." }] };
  f.complete(changed, 2);
  const review = native.importReview(f.root, f.feature.id, "review");
  assert.equal(review.attempt, 2);
  assert.equal(review.verdict, "changes_requested");
  assert.equal(review.findings[0].id, "missing-proof");
  assert.deepEqual(features.getFeature(f.root, f.feature.id).reviews, [first, review]);
});

test("native review import validates candidate, verdict and findings before recording evidence", (t) => {
  const f = reviewFixture(t);
  f.startReview();
  f.complete();
  const current = jobs.getJob(f.root, "review");
  const file = path.join(f.root, ".agent-team", "state", "jobs", "review.json");
  const cases = [
    ["not json", SyntaxError],
    [JSON.stringify({ ...f.result, candidate: { ...f.result.candidate, generation: 999 } }), /stale/],
    [JSON.stringify({ ...f.result, brief_hash: "different" }), /stale/],
    [JSON.stringify({ ...f.result, verdict: "looks good" }), /verdict/],
    [JSON.stringify({ ...f.result, findings: undefined }), /findings/]
  ];
  for (const [result, expected] of cases) {
    fs.writeFileSync(file, JSON.stringify({ ...current, reported_result: { ...current.reported_result, result } }));
    assert.throws(() => native.importReview(f.root, f.feature.id, "review"), expected);
    assert.deepEqual(features.getFeature(f.root, f.feature.id).reviews, []);
  }
});

test("session MCP executable uses its exact launch context and cannot read a sibling inbox", (t) => {
  const f = fixture(t);
  f.start("sender");
  const recipient = f.start("recipient", { role: "frontend" });
  f.start("sibling", { role: "frontend" });
  jobs.sendJobMessage(f.root, { from_job: "sender", to_job: "recipient", body: "Only recipient may read this" });
  jobs.sendJobMessage(f.root, { from_job: "sender", to_job: "sibling", body: "Sibling private assignment" });
  const launch = launchData(native.buildNativeCommand(f.root, recipient, { claude_bin: "claude-fixture-only" }));
  const mcp = mcpConfig(launch);
  // Local stdio only; inbox/handshake requests never invoke the wake callback.
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "team_inbox", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "team_inbox", arguments: { job_id: "sibling" } } }
  ].map(encodeFrame).join("");
  const result = spawnSync(mcp.command, mcp.args, { cwd: f.temporary, input, encoding: "utf8", timeout: 10000, env: { ...process.env, AGENT_TEAM_HEADLESS: "1" } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const { messages, remaining } = decodeFrames(Buffer.from(result.stdout));
  assert.equal(remaining.length, 0);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].result.serverInfo.name, "agent-team-job");
  const inbox = JSON.parse(messages[1].result.content[0].text).messages;
  assert.deepEqual(inbox.map((message) => message.body), ["Only recipient may read this"]);
  assert.equal(inbox[0].metadata.to_job, "recipient");
  assert.equal(messages[2].result.isError, true);
  jobs.finishJob(f.root, "recipient", 1, { status: "failed", process_stopped: true });
  jobs.claimJob(f.root, "recipient", { max_active: 3 });
  const stale = spawnSync(mcp.command, mcp.args, { cwd: f.temporary, input, encoding: "utf8", timeout: 10000 });
  assert.ifError(stale.error);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale/);
  assert.equal(stale.stdout, "");
});
