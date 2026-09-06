const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { start } = require("../src/team/start");
const jobs = require("../src/team/jobs");

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "team-start-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, "source project");
  fs.mkdirSync(project);
  execFileSync("git", ["init", "--initial-branch=main", project], { stdio: "ignore" });
  const bin = path.join(dir, "native cli");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const calls = { project: 0, session: 0 };
  const workspace_id = crypto.randomUUID();
  const transport = {
    createProject() { calls.project++; return { workspace_id, surface_id: crypto.randomUUID() }; },
    createSession(input) { calls.session++; assert.equal(input.workspace_id, workspace_id); return { workspace_id, surface_id: crypto.randomUUID() }; }
  };
  return {
    dir, project, bin, calls, transport,
    values: { project, "codex-bin": bin, "claude-bin": bin },
    context: { platform: "darwin", env: { CMUX_WORKSPACE_ID: crypto.randomUUID() }, home: path.join(dir, "home"), transport }
  };
}

test("public starter creates an isolated coordinator and preserves paths with spaces", (t) => {
  const f = fixture(t);
  const result = start(f.values, f.context);
  assert.equal(result.job.status, "launching");
  assert.equal(result.job.ready_at, undefined);
  assert.equal(result.job.checkout, result.coordinator);
  assert.equal(result.job.runtime, "codex");
  assert.equal(result.job.model, "gpt-6-astra");
  assert.notEqual(result.coordinator, f.project);
  const launch = JSON.parse(fs.readFileSync(path.join(result.coordinator, ".agent-team", "sessions", result.job.id, "1", "launch.json")));
  assert.equal(launch.argv[0], f.bin);
  assert.equal(launch.cwd, result.coordinator);
  assert.ok(launch.argv.at(-1).includes(f.project));
  assert.ok(launch.argv.at(-1).includes("--max-active"));
  const guide = path.resolve(__dirname, "../..", "docs/cmux-team.md");
  assert.ok(fs.existsSync(guide));
  assert.ok(launch.argv.at(-1).includes(guide));
  assert.equal(fs.existsSync(path.join(f.project, ".agent-team")), false);
  assert.deepEqual(f.calls, { project: 1, session: 1 });
});

test("repeated startup and changed configuration cannot allocate a second active lead", (t) => {
  const f = fixture(t);
  const first = start(f.values, f.context);
  const second = start(f.values, f.context);
  assert.equal(second.reused, true);
  assert.equal(second.job.id, first.job.id);
  assert.throws(() => start({ ...f.values, "max-active": "8" }, f.context), /different startup configuration/);
  assert.deepEqual(f.calls, { project: 1, session: 1 });
});

test("a stopped lead gets a new identity, but active workers prevent replacement", (t) => {
  const f = fixture(t);
  const first = start(f.values, f.context);
  jobs.finishJob(first.coordinator, first.job.id, first.job.attempt, { status: "cancelled", process_stopped: true, result: "fixture has no process" });
  const worker = jobs.createJob(first.coordinator, { id: "worker", leader: "codex", role: "backend", model: "gpt-6-astra", cwd: f.project, writable: true, prompt: "fixture" });
  jobs.claimJob(first.coordinator, worker.id, { max_active: 4 });
  assert.throws(() => start(f.values, f.context), /previous lead are still active/);
  jobs.finishJob(first.coordinator, worker.id, 1, { status: "cancelled", process_stopped: true, result: "fixture has no process" });
  const second = start(f.values, f.context);
  assert.notEqual(second.job.id, first.job.id);
  assert.deepEqual(f.calls, { project: 1, session: 2 });
});

test("uncertain native allocation preserves the claim and prevents duplicate launch", (t) => {
  const f = fixture(t);
  f.transport.createSession = () => { f.calls.session++; throw new Error("allocation response lost"); };
  assert.throws(() => start(f.values, f.context), /allocation response lost/);
  const result = start(f.values, f.context);
  assert.equal(result.reused, true);
  assert.equal(result.job.status, "launching");
  assert.equal(result.job.process_stopped, false);
  assert.deepEqual(f.calls, { project: 1, session: 1 });
});

test("Claude lead and explicit models are carried into the native startup and routing brief", (t) => {
  const f = fixture(t);
  const result = start({ ...f.values, leader: "claude", "claude-model": "claude-selected", "codex-model": "codex-selected" }, f.context);
  assert.equal(result.job.runtime, "claude");
  assert.equal(result.job.model, "claude-selected");
  const launch = JSON.parse(fs.readFileSync(path.join(result.coordinator, ".agent-team", "sessions", result.job.id, "1", "launch.json")));
  assert.equal(launch.argv[launch.argv.indexOf("--model") + 1], "claude-selected");
  assert.ok(launch.argv.at(-1).includes("model codex-selected"));
  assert.ok(launch.argv.at(-1).includes("opposite lead runtime"));
});

test("invalid environment, capacity and project overlap fail before allocating or writing coordinator state", (t) => {
  const f = fixture(t);
  assert.throws(() => start(f.values, { ...f.context, platform: "linux" }), /requires macOS/);
  assert.throws(() => start(f.values, { ...f.context, env: {} }), /inside cmux/);
  assert.throws(() => start({ ...f.values, "max-active": "1" }, f.context), /at least 2/);
  assert.throws(() => start({ ...f.values, coordinator: path.join(f.project, "state") }, f.context), /separate from the project/);
  assert.throws(() => start({ ...f.values, coordinator: f.dir }, f.context), /separate from the project/);
  assert.equal(fs.existsSync(f.context.home), false);
  assert.equal(fs.existsSync(path.join(f.project, "state")), false);
  assert.deepEqual(f.calls, { project: 0, session: 0 });
});

test("starter preserves unrelated files in a supplied coordinator", (t) => {
  const f = fixture(t);
  const coordinator = path.join(f.dir, "personal");
  fs.mkdirSync(coordinator);
  fs.writeFileSync(path.join(coordinator, "keep.txt"), "personal data");
  assert.throws(() => start({ ...f.values, coordinator }, f.context), /nonempty coordinator/);
  assert.equal(fs.readFileSync(path.join(coordinator, "keep.txt"), "utf8"), "personal data");
  assert.equal(fs.existsSync(path.join(coordinator, ".git")), false);
  assert.deepEqual(f.calls, { project: 0, session: 0 });
});
