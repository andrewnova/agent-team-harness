const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { tempRoot } = require("./helpers");
const mailbox = require("../src/mailbox");
const jobs = require("../src/team/jobs");

function fixture(t) {
  const root = fs.realpathSync(tempRoot());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const create = (id, input = {}) => jobs.createJob(root, {
    id, leader: "codex", role: "backend", model: "test-model", cwd: root,
    writable: false, prompt: "Test assignment", ...input
  });
  const start = (id, input = {}) => {
    create(id, input);
    return jobs.claimJob(root, id, { max_active: 8 });
  };
  return { root, create, start };
}

test("a new review round starts a fresh attempt after the previous process stops", (t) => {
  const { root, start } = fixture(t);
  start("reviewer", { role: "review" });
  jobs.reportJob(root, "reviewer", 1, { status: "completed", result: "round one" });
  assert.throws(() => jobs.claimJob(root, "reviewer", { max_active: 2 }), /cannot be claimed/);
  jobs.finishJob(root, "reviewer", 1, { status: "completed", process_stopped: true });
  const next = jobs.claimJob(root, "reviewer", { max_active: 2 });
  assert.equal(next.attempt, 2);
  assert.equal(next.reported_result, undefined);
  assert.equal(next.previous_attempts[0].reported_result.result, "round one");
  assert.throws(() => jobs.reportJob(root, "reviewer", 1, { status: "completed", result: "late" }), /stale/);
});

test("routing is symmetric and explicit; invalid assignments cannot mutate routing", (t) => {
  const { root, create } = fixture(t);
  for (const leader of ["codex", "claude"]) {
    assert.equal(jobs.routeRuntime(leader, "lead"), leader);
    assert.equal(jobs.routeRuntime(leader, "backend"), "codex");
    assert.equal(jobs.routeRuntime(leader, "frontend"), "claude");
    assert.equal(jobs.routeRuntime(leader, "review"), leader === "codex" ? "claude" : "codex");
  }
  assert.equal(jobs.routeRuntime("codex", "research"), null);
  assert.throws(() => jobs.routeRuntime("human", "backend"), /leader/);
  assert.throws(() => create("a", { model: undefined }), /model/);
  assert.throws(() => create("a", { role: "research" }), /explicit runtime/);
  assert.throws(() => create("a", { runtime: "claude" }), /must route/);
  assert.throws(() => create("../escape"), /path-safe/);
  assert.throws(() => create("a", { cwd: "." }), /absolute/);
  assert.throws(() => create("a", { writable: "yes" }), /boolean/);
  assert.throws(() => create("a", { feature_id: "../other" }), /path-safe/);
  const a = create("a", { status: "completed", attempt: 10 });
  assert.equal(a.status, "queued");
  assert.equal(a.attempt, 0);
  assert.equal(a.model, "test-model");
  assert.throws(() => create("a", { role: "frontend" }), /already exists/);
  assert.equal(jobs.getJob(root, "a").runtime, "codex");
  assert.equal(create("custom", { role: "research", runtime: "claude" }).runtime, "claude");
});

test("dependencies require completed work, capacity includes cancelling, retries fence attempts", (t) => {
  const { root, create } = fixture(t);
  assert.throws(() => create("self", { dependencies: ["self"] }), /itself/);
  assert.throws(() => create("unknown", { dependencies: ["missing"] }), /ENOENT/);
  create("a");
  create("b", { dependencies: ["a"] });
  assert.throws(() => jobs.claimJob(root, "b", { max_active: 2 }), /dependency/);
  assert.throws(() => jobs.claimJob(root, "a", { max_active: 0 }), /max_active/);
  const a = jobs.claimJob(root, "a", { max_active: 1 });
  assert.equal(a.attempt, 1);
  assert.throws(() => jobs.claimJob(root, "a", { max_active: 2 }), /cannot be claimed/);
  jobs.reportJob(root, "a", 1, { status: "completed", result: "reported" });
  assert.throws(() => jobs.claimJob(root, "b", { max_active: 2 }), /dependency/);
  jobs.cancelJob(root, "a", 1);
  create("c");
  assert.throws(() => jobs.claimJob(root, "c", { max_active: 1 }), /capacity/);
  assert.throws(() => jobs.finishJob(root, "a", 1, { status: "failed", process_stopped: false }), /process_stopped/);
  const finished = jobs.finishJob(root, "a", 1, { status: "failed", process_stopped: true });
  assert.equal(finished.result, "reported");
  assert.deepEqual(jobs.finishJob(root, "a", 1, { status: "failed", process_stopped: true }), finished);
  assert.throws(() => jobs.finishJob(root, "a", 1, { status: "completed", process_stopped: true }), /different outcome/);
  const retry = jobs.claimJob(root, "a", { max_active: 1 });
  assert.equal(retry.attempt, 2);
  assert.equal(retry.previous_attempts[0].result, "reported");
  assert.equal(retry.reported_result, undefined);
  assert.throws(() => jobs.finishJob(root, "a", 1, { status: "completed", process_stopped: true }), /stale/);
  assert.throws(() => jobs.reportJob(root, "a", 1, { status: "ready" }), /stale/);
  jobs.finishJob(root, "a", 2, { status: "completed", result: { summary: "done" }, process_stopped: true });
  assert.equal(jobs.claimJob(root, "b", { max_active: 1 }).status, "launching");
  assert.throws(() => jobs.claimJob(root, "a", { max_active: 2 }), /cannot be claimed/);
});

test("surface allocation and readiness are separate, cancellation never releases a writer", (t) => {
  const { root, start, create } = fixture(t);
  start("writer", { writable: true });
  const surface = { workspace_id: "workspace-1", surface_id: "surface-1" };
  assert.equal(jobs.bindJob(root, "writer", 1, surface).status, "launching");
  assert.throws(() => jobs.bindJob(root, "writer", 2, surface), /stale/);
  assert.throws(() => jobs.bindJob(root, "writer", 1, { ...surface, surface_id: "other" }), /already bound/);
  assert.equal(jobs.reportJob(root, "writer", 1, { status: "ready" }).status, "running");
  assert.equal(jobs.reportJob(root, "writer", 1, { status: "completed", result: "done" }).status, "running");
  create("next", { writable: true });
  assert.throws(() => jobs.claimJob(root, "next", { max_active: 8 }), /already has a writer/);
  jobs.cancelJob(root, "writer", 1);
  assert.throws(() => jobs.claimJob(root, "next", { max_active: 8 }), /already has a writer/);
  assert.throws(() => jobs.reportJob(root, "writer", 1, { status: "ready" }), /cancelling/);
  assert.equal(jobs.bindJob(root, "writer", 1, { ...surface, ready: true }).status, "cancelling");
  jobs.finishJob(root, "writer", 1, { status: "completed", process_stopped: true });
  jobs.claimJob(root, "next", { max_active: 8 });
  assert.equal(jobs.reportJob(root, "next", 1, { status: "ready" }).status, "launching");
  assert.equal(jobs.bindJob(root, "next", 1, surface).status, "running");
});

test("canonical coordinator, symlink cwd and checkout subdirectories share writer ownership", (t) => {
  const { root, create } = fixture(t);
  const repo = path.join(root, "repo");
  const alias = path.join(root, "alias");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "tests"));
  fs.writeFileSync(path.join(repo, ".git"), "gitdir: fake-test-only\n");
  fs.symlinkSync(repo, alias, "dir");
  create("a", { cwd: alias, writable: true });
  create("b", { cwd: path.join(repo, "src"), writable: true });
  create("c", { cwd: path.join(repo, "tests"), writable: true });
  assert.equal(jobs.getJob(root, "a").cwd, repo);
  jobs.claimJob(root, "a", { max_active: 8 });
  for (const id of ["b", "c"]) assert.throws(() => jobs.claimJob(root, id, { max_active: 8 }), /writer/);
  create("reader", { cwd: alias });
  assert.equal(jobs.claimJob(root, "reader", { max_active: 8 }).status, "launching");
  const coordinatorAlias = path.join(root, "coordinator-alias");
  fs.symlinkSync(root, coordinatorAlias, "dir");
  assert.deepEqual(jobs.listJobs(coordinatorAlias), jobs.listJobs(root));
  const lock = path.join(root, ".agent-team", "state", "jobs.lock");
  fs.mkdirSync(lock);
  assert.throws(() => jobs.claimJob(coordinatorAlias, "b", { max_active: 8 }), /locked/);
  fs.rmdirSync(lock);
});

test("filesystem corruption and aliased state fail visibly", (t) => {
  const { root, create } = fixture(t);
  assert.deepEqual(jobs.listJobs(root), []);
  create("a");
  const record = path.join(root, ".agent-team", "state", "jobs", "a.json");
  fs.writeFileSync(record, "{broken");
  assert.throws(() => jobs.listJobs(root), SyntaxError);
  fs.unlinkSync(record);
  const stateDir = path.dirname(record);
  fs.renameSync(stateDir, `${stateDir}-real`);
  fs.symlinkSync(`${stateDir}-real`, stateDir, "dir");
  assert.throws(() => create("b"), /symlink aliases/);
});

test("failed atomic state write preserves queued job and releases the operation lock", (t) => {
  const { root, create } = fixture(t);
  create("a");
  const record = path.join(root, ".agent-team", "state", "jobs", "a.json");
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === record) throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    return rename(from, to);
  });
  assert.throws(() => jobs.claimJob(root, "a", { max_active: 1 }), /simulated EIO/);
  assert.equal(jobs.getJob(root, "a").status, "queued");
  assert.deepEqual(fs.readdirSync(path.dirname(record)), ["a.json"]);
  mocked.mock.restore();
  assert.equal(jobs.claimJob(root, "a", { max_active: 1 }).attempt, 1);
});

test("atomic root-wide claims admit only one concurrent writer or one capacity slot", { timeout: 10000 }, async (t) => {
  const { root, create } = fixture(t);
  create("a", { writable: true });
  create("b", { writable: true });
  const script = `
    const jobs = require(process.argv[1]);
    process.send('ready');
    process.once('message', ({root, id, max_active}) => {
      try { jobs.claimJob(root, id, {max_active}); process.send({ok:true}); }
      catch (error) { process.send({ok:false, error:error.message}); }
      process.disconnect();
    });
  `;
  async function race(ids, max_active) {
    const children = ids.map(() => spawn(process.execPath, ["-e", script, require.resolve("../src/team/jobs")], { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
    t.after(() => children.forEach((child) => { if (child.exitCode === null) child.kill(); }));
    await Promise.all(children.map((child) => new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", (code) => { if (code) reject(new Error(`claim helper exited ${code}`)); });
    })));
    const results = children.map((child) => new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
    }));
    children.forEach((child, index) => child.send({ root, id: ids[index], max_active }));
    return Promise.all(results);
  }
  let results = await race(["a", "b"], 8);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.match(results.find((result) => !result.ok).error, /locked|writer/);
  const active = jobs.listJobs(root).find((job) => job.status === "launching");
  jobs.finishJob(root, active.id, 1, { status: "completed", process_stopped: true });
  create("same");
  results = await race(["same", "same"], 8);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.match(results.find((result) => !result.ok).error, /locked|cannot be claimed/);
  jobs.finishJob(root, "same", 1, { status: "completed", process_stopped: true });
  create("c"); create("d");
  results = await race(["c", "d"], 1);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.match(results.find((result) => !result.ok).error, /locked|capacity/);
});

test("addressed inbox excludes legacy broadcasts, other jobs and stale sender attempts", (t) => {
  const { root, start } = fixture(t);
  start("lead", { role: "lead" });
  start("worker", { role: "frontend" });
  start("sibling", { role: "frontend" });
  const request = jobs.sendJobMessage(root, { from_job: "lead", to_job: "worker", body: "implement" });
  assert.equal(request.request_id, request.id);
  assert.equal(request.from, "codex");
  assert.equal(request.to, "claude");
  assert.deepEqual(request.metadata, { from_job: "lead", from_attempt: 1, to_job: "worker", to_attempt: 1 });
  mailbox.appendMessage(root, { from: "codex", to: "claude", body: "legacy broadcast" });
  assert.deepEqual(jobs.jobInbox(root, "sibling", 1), []);
  assert.equal(jobs.jobInbox(root, "worker", 1).length, 1);
  assert.throws(() => jobs.sendJobMessage(root, { from_job: "sibling", to_job: "lead", body: "spoof", in_reply_to: request.id }), /addressed between/);
  const reply = jobs.sendJobMessage(root, { from_job: "worker", to_job: "lead", body: "done", in_reply_to: request.request_id });
  assert.equal(reply.request_id, request.request_id);
  assert.equal(jobs.jobInbox(root, "lead", 1)[0].body, "done");
  const followup = jobs.sendJobMessage(root, { from_job: "lead", to_job: "worker", body: "Thanks", in_reply_to: request.request_id });
  assert.equal(followup.in_reply_to, reply.id);
  assert.equal(followup.request_id, request.request_id);
  jobs.finishJob(root, "worker", 1, { status: "failed", process_stopped: true });
  jobs.claimJob(root, "worker", { max_active: 8 });
  assert.deepEqual(jobs.jobInbox(root, "worker", 2), []);
  assert.deepEqual(jobs.jobInbox(root, "lead", 1), []);
  assert.throws(() => jobs.jobInbox(root, "worker", 1), /stale/);
  assert.throws(() => jobs.sendJobMessage(root, { from_job: "worker", from_attempt: 1, to_job: "lead", body: "late" }), /stale/);
  assert.throws(() => jobs.sendJobMessage(root, { from_job: "worker", to_job: "lead", body: "late", in_reply_to: request.id }), /addressed between/);
});

test("same-runtime jobs communicate and unreadable durable messages fail visibly", (t) => {
  const { root, start } = fixture(t);
  start("a"); start("b");
  const body = `${"long result ".repeat(400)}\n`;
  const message = jobs.sendJobMessage(root, { from_job: "a", to_job: "b", body });
  assert.equal(jobs.jobInbox(root, "b", 1)[0].body, body);
  fs.unlinkSync(path.join(root, message.body_path));
  assert.throws(() => jobs.jobInbox(root, "b", 1), /ENOENT/);
  fs.appendFileSync(path.join(root, ".agent-team", "comms", "mailbox.jsonl"), "{broken\n");
  assert.throws(() => jobs.jobInbox(root, "a", 1), /malformed/);
  assert.throws(() => jobs.sendJobMessage(root, { from_job: "a", to_job: "b", body: "new" }), /malformed/);
});
