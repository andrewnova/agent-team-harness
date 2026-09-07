const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempRoot } = require("./helpers");
const jobs = require("../src/team/jobs");
const features = require("../src/team/features");
const native = require("../src/team/native");
const teamCli = require("../src/team/cli");

const cli = require.resolve("../src/cli");

function fixture(t) {
  const temporary = fs.realpathSync(tempRoot());
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "explicit coordinator");
  const cwd = path.join(temporary, "caller checkout");
  fs.mkdirSync(root);
  fs.mkdirSync(cwd);
  const env = { ...process.env, AGENT_TEAM_HEADLESS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CODEX_THREAD_ID", "CLAUDECODE"]) delete env[key];
  // A preload makes accidental native execution a test failure, including the
  // cmux adapter's absolute application-binary fallback outside PATH.
  const guard = path.join(temporary, "forbid-native.cjs");
  fs.writeFileSync(guard, `
    const cp = require('node:child_process');
    for (const method of ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec']) {
      const original = cp[method];
      cp[method] = (file, ...args) => {
        if (!['git', process.execPath].includes(file)) throw new Error('Unexpected external execution: ' + file);
        return original(file, ...args);
      };
    }
  `);
  const run = (args) => {
    const result = spawnSync(process.execPath, ["--require", guard, cli, "--cwd", root, "team", ...args], { cwd, env, encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  };
  const json = (name, value) => {
    const file = path.join(temporary, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const assignment = (id, overrides = {}) => ({
    id, leader: "codex", role: "backend", model: "explicit-test-model", cwd,
    writable: false, prompt: "Test assignment", ...overrides
  });
  const start = (id, overrides) => {
    jobs.createJob(root, assignment(id, overrides));
    return jobs.claimJob(root, id, { max_active: 8 });
  };
  return { temporary, root, cwd, env, run, json, assignment, start };
}

function output(result, status = 0) {
  assert.equal(result.status, status, result.stderr || result.stdout);
  // Node 22 emits this built-in SQLite diagnostic when the lock first opens.
  // Keep rejecting all other stderr, including actual CLI failures.
  assert.match(result.stderr, /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n)?$/);
  return JSON.parse(result.stdout);
}

async function invoke(t, root, args) {
  let stdout = "";
  const write = t.mock.method(process.stdout, "write", (chunk) => { stdout += String(chunk); return true; });
  try {
    const code = await teamCli.main(args, root);
    return { code, value: JSON.parse(stdout) };
  } finally {
    write.mock.restore();
  }
}

test("public CLI wrapper routes team help without creating legacy or native state", (t) => {
  const f = fixture(t);
  for (const args of [[], ["--help"], ["job", "launch", "unused", "--help"], ["feature", "import-review", "unused", "--help"]]) {
    const result = f.run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /team <command>/);
    assert.match(result.stdout, /job launch.*--max-active/);
    assert.match(result.stdout, /--codex-bin/);
    assert.match(result.stdout, /--claude-bin/);
    assert.match(result.stdout, /feature import-review/);
    assert.match(result.stdout, /explicit model IDs/);
    assert.deepEqual(fs.readdirSync(f.root), []);
    assert.deepEqual(fs.readdirSync(f.cwd), []);
  }
});

test("public CLI creates, lists and shows jobs in the explicit coordinator root", (t) => {
  const f = fixture(t);
  assert.deepEqual(output(f.run(["job", "list"])), []);
  const input = f.assignment("frontend", { leader: "claude", role: "frontend", model: "pinned-frontend-model" });
  const created = output(f.run(["job", "create", "--json", f.json("assignment", input)]));
  assert.equal(created.id, "frontend");
  assert.equal(created.model, "pinned-frontend-model");
  assert.equal(created.runtime, "claude");
  assert.equal(created.status, "queued");
  assert.equal(created.attempt, 0);
  assert.equal(created.cwd, f.cwd);
  assert.deepEqual(output(f.run(["job", "show", "frontend"])), created);
  assert.deepEqual(output(f.run(["job", "list"])), [created]);
  assert.equal(fs.existsSync(path.join(f.root, ".agent-team", "state", "jobs", "frontend.json")), true);
  assert.deepEqual(fs.readdirSync(f.cwd), []);
  assert.equal(fs.existsSync(path.join(f.root, ".agent-team", "sessions")), false);
});

test("CLI rejects missing models, unsupported commands and missing required arguments", (t) => {
  const f = fixture(t);
  const missingModel = f.json("missing-model", f.assignment("bad", { model: undefined }));
  const cases = [
    [["job", "create", "--json", missingModel], /model/],
    [["job", "create"], /--json is required/],
    [["job", "launch", "unused"], /--max-active is required/],
    [["feature", "import-review", "unused"], /--job is required/],
    [["feature", "unknown"], /unknown team feature operation/],
    [["unknown"], /unknown team command/]
  ];
  for (const [args, error] of cases) {
    const result = f.run(args);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, error);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(jobs.listJobs(f.root), []);
  assert.equal(fs.existsSync(path.join(f.root, ".agent-team", "sessions")), false);
});

test("CLI launch forwards numeric capacity and both exact native binary overrides", async (t) => {
  const f = fixture(t);
  const result = { id: "worker", status: "launching", attempt: 2 };
  const launch = t.mock.method(native, "launchJob", () => result);
  const bins = ["/fixture/validated codex/bin/codex", "/fixture/validated claude/bin/claude"];
  assert.deepEqual(await invoke(t, f.root, ["job", "launch", "worker", "--max-active", "3", "--codex-bin", bins[0], "--claude-bin", bins[1]]), { code: 0, value: result });
  assert.deepEqual(launch.mock.calls[0].arguments, [f.root, "worker", { max_active: 3, codex_bin: bins[0], claude_bin: bins[1] }]);
  await invoke(t, f.root, ["job", "launch", "worker", "--max-active", "1"]);
  assert.deepEqual(launch.mock.calls[1].arguments, [f.root, "worker", { max_active: 1 }]);
  await assert.rejects(invoke(t, f.root, ["job", "launch", "worker", "--max-active", "1", "--codex-bin"]), /--codex-bin is required/);
  await assert.rejects(invoke(t, f.root, ["job", "launch", "worker", "--max-active", "1", "--claude-bin"]), /--claude-bin is required/);
  assert.equal(launch.mock.callCount(), 2);
});

test("CLI cancellation preserves an active writer and inbox uses the current attempt", (t) => {
  const f = fixture(t);
  f.start("sender");
  f.start("writer", { writable: true });
  const message = jobs.sendJobMessage(f.root, { from_job: "sender", to_job: "writer", body: "First attempt only" });
  assert.deepEqual(output(f.run(["job", "inbox", "writer"])).map((item) => item.id), [message.id]);
  const cancelling = output(f.run(["job", "cancel", "writer"]));
  assert.equal(cancelling.status, "cancelling");
  assert.equal(cancelling.process_stopped, false);
  jobs.createJob(f.root, f.assignment("next", { writable: true }));
  assert.throws(() => jobs.claimJob(f.root, "next", { max_active: 8 }), /writer/);
  jobs.finishJob(f.root, "writer", 1, { status: "cancelled", process_stopped: true });
  jobs.claimJob(f.root, "writer", { max_active: 8 });
  assert.deepEqual(output(f.run(["job", "inbox", "writer"])), []);
});

test("CLI send derives actor identity and reports wake failure without losing the message", async (t) => {
  const f = fixture(t);
  f.start("sender");
  f.start("recipient");
  const wake = t.mock.method(native, "wakeMessage", () => { throw new Error("fixture wake unavailable"); });
  const file = f.json("send", { to_job: "recipient", body: "Read durable work", from_job: "spoof", from_attempt: 999 });
  const { code, value } = await invoke(t, f.root, ["job", "send", "sender", "--json", file]);
  assert.equal(code, 0);
  assert.deepEqual(value.delivery, { status: "failed", error: "fixture wake unavailable" });
  assert.equal(value.message.metadata.from_job, "sender");
  assert.equal(value.message.metadata.from_attempt, 1);
  assert.equal(wake.mock.callCount(), 1);
  const [wakeRoot, wakeMessage] = wake.mock.calls[0].arguments;
  assert.equal(wakeRoot, f.root);
  assert.equal(wakeMessage.id, value.message.id);
  assert.deepEqual(wakeMessage.metadata, value.message.metadata);
  const inbox = jobs.jobInbox(f.root, "recipient", 1);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].id, value.message.id);
  assert.equal(inbox[0].body, "Read durable work");
});

test("CLI wake accepts only messages in that job's current addressed inbox", async (t) => {
  const f = fixture(t);
  f.start("sender");
  f.start("recipient");
  f.start("sibling");
  const message = jobs.sendJobMessage(f.root, { from_job: "sender", to_job: "recipient", body: "Addressed work" });
  const wake = t.mock.method(native, "wakeMessage", () => ({ status: "submitted", semantic_reply_confirmed: false }));
  const response = await invoke(t, f.root, ["job", "wake", "recipient", "--message", message.id]);
  assert.equal(response.value.semantic_reply_confirmed, false);
  assert.equal(wake.mock.calls[0].arguments[1].id, message.id);
  await assert.rejects(invoke(t, f.root, ["job", "wake", "sibling", "--message", message.id]), /not in current addressed inbox/);
  jobs.finishJob(f.root, "recipient", 1, { status: "failed", process_stopped: true });
  jobs.claimJob(f.root, "recipient", { max_active: 8 });
  await assert.rejects(invoke(t, f.root, ["job", "wake", "recipient", "--message", message.id]), /not in current addressed inbox/);
  assert.equal(wake.mock.callCount(), 1);
});

test("public CLI feature status returns a failing exit code until review and checks pass", (t) => {
  const f = fixture(t);
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-b", "main");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Keep CLI acceptance fixtures isolated");
  const input = { id: "feature", repo: f.cwd, leader: "codex", brief: "Require reviewed and tested source", review_jobs: ["review"], checks: [{ id: "unit", command: [process.execPath, "-e", "process.stdout.write('fixture check passed')"] }] };
  const feature = output(f.run(["feature", "create", "--json", f.json("feature", input)]));
  assert.equal(feature.id, "feature");
  const initial = output(f.run(["feature", "status", feature.id]), 1);
  assert.equal(initial.eligible, false);
  assert.match(initial.reasons.join("\n"), /frozen candidate/);
  const { candidate } = output(f.run(["feature", "snapshot", feature.id]));
  f.start("review", { role: "review", feature_id: feature.id, cwd: feature.cwd });
  jobs.reportJob(f.root, "review", 1, { status: "completed", result: JSON.stringify({ candidate, brief_hash: candidate.brief_hash, verdict: "approve", findings: [] }) });
  jobs.finishJob(f.root, "review", 1, { status: "completed", process_stopped: true });
  const imported = output(f.run(["feature", "import-review", feature.id, "--job", "review"]));
  assert.equal(imported.reviewer_job_id, "review");
  assert.equal(imported.attempt, 1);
  const unchecked = output(f.run(["feature", "status", feature.id]), 1);
  assert.match(unchecked.reasons.join("\n"), /check missing/);
  assert.equal(output(f.run(["feature", "check", feature.id])).status, "completed");
  const accepted = output(f.run(["feature", "status", feature.id]));
  assert.equal(accepted.eligible, true);
  assert.deepEqual(accepted.reasons, []);
  const log = features.getFeature(f.root, feature.id).check_runs.at(-1).results[0].stdout_path;
  fs.writeFileSync(log, "tampered");
  const tampered = output(f.run(["feature", "status", feature.id]), 1);
  assert.equal(tampered.eligible, false);
  assert.match(tampered.reasons.join("\n"), /check evidence changed/);
});

test("public collection imports a complete round idempotently and exposes pending, failed and stale reviews", (t) => {
  const f = fixture(t);
  for (const args of [["init", "-b", "main"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Keep collection proof isolated"]]) {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: f.cwd, env: f.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const feature = features.createFeature(f.root, { id: "round", repo: f.cwd, leader: "codex", brief: "Both required reviewers must finish",
    review_jobs: ["first", "second"], checks: [{ id: "unit", command: [process.execPath, "--version"] }] });
  const { candidate } = features.snapshotFeature(f.root, feature.id);
  const verdict = { candidate, brief_hash: candidate.brief_hash, verdict: "approve", findings: [] };
  for (const id of feature.review_jobs) f.start(id, { role: "review", feature_id: feature.id, cwd: feature.cwd });
  const complete = (id, attempt = 1) => {
    jobs.reportJob(f.root, id, attempt, { status: "completed", result: JSON.stringify(verdict) });
    jobs.finishJob(f.root, id, attempt, { status: "completed", process_stopped: true });
  };
  complete("first");
  jobs.reportJob(f.root, "second", 1, { status: "completed", result: JSON.stringify(verdict) });
  const partial = output(f.run(["feature", "collect", feature.id]), 1);
  assert.deepEqual(partial.reviews.map((review) => review.reviewer_job_id), ["first"]);
  assert.equal(partial.pending[0].job_id, "second");
  assert.equal(partial.pending[0].result_reported, true);
  assert.equal(partial.eligible, false);
  assert.equal(features.getFeature(f.root, feature.id).check_runs.length, 0, "collection must not silently rerun checks");
  jobs.finishJob(f.root, "second", 1, { status: "completed", process_stopped: true });
  features.runFeatureChecks(f.root, feature.id);
  assert.equal(output(f.run(["feature", "collect", feature.id])).eligible, true);
  const saved = features.getFeature(f.root, feature.id);
  assert.equal(output(f.run(["feature", "collect", feature.id])).eligible, true);
  assert.deepEqual(features.getFeature(f.root, feature.id), saved, "unchanged evidence is not rewritten");
  jobs.claimJob(f.root, "second", { max_active: 2 });
  assert.equal(output(f.run(["feature", "collect", feature.id]), 1).pending[0].attempt, 2);
  jobs.cancelJob(f.root, "second", 2);
  jobs.finishJob(f.root, "second", 2, { status: "cancelled", process_stopped: true });
  assert.match(output(f.run(["feature", "collect", feature.id]), 1).errors[0].error, /cancelled/);
  jobs.claimJob(f.root, "second", { max_active: 2 });
  complete("second", 3);
  assert.equal(output(f.run(["feature", "collect", feature.id])).eligible, true);
  fs.writeFileSync(path.join(feature.cwd, "unreviewed.txt"), "changed source");
  const stale = output(f.run(["feature", "collect", feature.id]), 1);
  assert.equal(stale.eligible, false);
  assert.equal(stale.errors.length, 2);
  assert.ok(stale.errors.every((error) => /clean/.test(error.error)));
});
