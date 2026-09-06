const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempRoot } = require("./helpers");

const cli = require.resolve("../src/cli");
const start = require.resolve("../src/team/start");
const fixturePreload = require.resolve("./fixtures/workflow-cmux.cjs");
const fixtureModel = require.resolve("./fixtures/workflow-model.cjs");
const { publishJson } = require(fixtureModel);

async function until(read, predicate, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
}

async function publishedReceipt(file, timeout = 12000) {
  return until(() => {
    try { return JSON.parse(fs.readFileSync(file)); } catch (error) {
      // The production runner publishes exit.json in place, twice. Only this
      // bounded receipt poll tolerates missing or incomplete publication.
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }, (value) => value?.delivery, "lifecycle delivery receipt", timeout);
}

function fixture(t) {
  const directory = fs.realpathSync(tempRoot());
  const root = path.join(directory, "coordinator with spaces");
  const repo = path.join(directory, "source with spaces");
  const model = path.join(directory, "native-model");
  fs.mkdirSync(repo);
  fs.writeFileSync(model, `#!${process.execPath}\nrequire(${JSON.stringify(fixtureModel)}).main().catch(error => { console.error(error); process.exit(1); });\n`, { mode: 0o700 });
  const env = { ...process.env, TEAM_WORKFLOW_FIXTURE: directory, TEAM_WORKFLOW_COORDINATOR: root,
    NODE_OPTIONS: `--require=${JSON.stringify(fixturePreload)}`, AGENT_TEAM_HEADLESS: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Workflow fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Workflow fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
    CMUX_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111" };
  for (const key of Object.keys(env)) {
    if ((key.startsWith("CMUX_") && key !== "CMUX_WORKSPACE_ID") || key.startsWith("CLAUDE") || key === "CODEX_THREAD_ID" ||
      ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"].includes(key)) delete env[key];
  }
  function execute(file, args, cwd = directory, status = 0) {
    const result = spawnSync(file, args, { cwd, env, encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, status, result.stderr || result.stdout);
    return result;
  }
  const git = (cwd, ...args) => execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], cwd).stdout.trim();
  git(repo, "init", "--initial-branch=main");
  fs.writeFileSync(path.join(repo, "answer.js"), "module.exports = () => 0;\n");
  fs.writeFileSync(path.join(repo, "check.js"), "require('node:assert/strict').equal(require('./answer')(), 42); console.log('answer verified');\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Keep workflow proof isolated from user source\n\nScope-risk: narrow\nTested: fixture initialization");
  const values = { project: repo, coordinator: root, "codex-bin": model, "claude-bin": model, "max-active": "4" };
  const starter = () => JSON.parse(execute(process.execPath, ["-e",
    // Only the native host gate is supplied on Linux CI; startup is otherwise real.
    "process.stdout.write(JSON.stringify(require(process.argv[1]).start(JSON.parse(process.argv[2]), {platform:'darwin'})))", start, JSON.stringify(values)]).stdout);
  const raw = (args, status = 0) => execute(process.execPath, [cli, "--cwd", root, "team", ...args], directory, status);
  const run = (args, status = 0) => JSON.parse(raw(args, status).stdout);
  let jsonId = 0;
  const json = (value) => {
    const file = path.join(directory, `input-${++jsonId}.json`);
    publishJson(file, value);
    return file;
  };
  const show = (id) => run(["job", "show", id]);
  const stateFile = (id) => path.join(root, ".agent-team", "state", "jobs", `${id}.json`);
  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(file)); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const wakes = (messageId) => fs.readdirSync(directory).filter((name) => /^rpc-.*\.json$/.test(name)).map((name) => read(path.join(directory, name)))
    .filter((row) => row.method === "surface.send_text" && row.params.text.includes(messageId));
  const jobState = (id) => read(stateFile(id));
  const prefix = (job) => path.join(directory, `${job.id}-${job.attempt}`);
  const boot = (job) => until(() => read(`${prefix(job)}.boot.json`), Boolean, `${job.id} MCP handshake`);
  const counters = new Map();
  async function command(job, input) {
    const key = prefix(job);
    const sequence = (counters.get(key) || 0) + 1;
    counters.set(key, sequence);
    publishJson(`${key}.${sequence}.request.json`, input);
    if (input.exit !== undefined) return;
    const response = await until(() => read(`${key}.${sequence}.response.json`), Boolean, `${job.id} ${input.name}`);
    assert.equal(response.error, undefined, JSON.stringify(response));
    const result = JSON.parse(response.result.content[0].text);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.report_error, undefined);
    return result;
  }
  const mcp = (job, name, args) => command(job, { name, args });
  async function holdRunner(job, observe) {
    const current = show(job.id);
    assert.equal(current.attempt, job.attempt);
    assert.equal(current.status, "running");
    assert.ok(Number.isSafeInteger(current.runner_pid) && current.runner_pid > 0);
    const hold = path.join(directory, `hold-${current.runner_pid}.json`);
    publishJson(hold, { job_id: job.id, attempt: job.attempt });
    try {
      const acknowledgement = await until(() => read(`${hold}.ack.json`), Boolean, `${job.id} runner inventory barrier`);
      assert.equal(acknowledgement.pid, current.runner_pid);
      return await observe();
    } finally {
      fs.rmSync(hold, { force: true });
      fs.rmSync(`${hold}.ack.json`, { force: true });
    }
  }
  async function ready(job) {
    const handshake = await boot(job);
    assert.equal(handshake.initialized.result.serverInfo.name, "agent-team-job");
    assert.deepEqual(handshake.listed.result.tools.map((tool) => tool.name).sort(), ["team_inbox", "team_reply", "team_report", "team_send"]);
    assert.equal(show(job.id).status, "launching");
    const result = await mcp(job, "team_report", { status: "ready" });
    assert.equal(result.job.status, "running");
    assert.ok(result.job.ready_at);
    return result.job;
  }
  const launch = (id, status = 0) => status === 0
    ? run(["job", "launch", id, "--max-active", "4", "--codex-bin", model, "--claude-bin", model])
    : raw(["job", "launch", id, "--max-active", "4", "--codex-bin", model, "--claude-bin", model], status);
  const create = (id, overrides = {}) => run(["job", "create", "--json", json({
    id, leader: "codex", role: "backend", model: "gpt-6-astra", cwd: repo, writable: false,
    prompt: "Deterministic integration assignment; native model is a fixture.", ...overrides
  })]);
  async function stopped(job, expected) {
    const waited = run(["job", "wait", job.id, "--until", "stopped", "--timeout-ms", "12000"]);
    assert.equal(waited.reached, true);
    assert.equal(waited.job.attempt, job.attempt);
    const current = show(job.id);
    assert.equal(current.status, expected);
    // The wait proves release; delivery has its own subsequent durable receipt.
    const exitFile = path.join(root, ".agent-team", "sessions", job.id, String(job.attempt), "exit.json");
    const receipt = await publishedReceipt(exitFile);
    assert.equal(receipt.process_stopped, true);
    assert.equal(receipt.attempt, job.attempt);
    assert.deepEqual(receipt.remaining, []);
    assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" });
    const notices = run(["job", "inbox", current.parent_job]).filter((message) => message.metadata.event === "job_stopped" &&
      message.metadata.from_job === job.id && message.metadata.from_attempt === job.attempt);
    assert.equal(notices.length, 1);
    const notice = notices[0];
    assert.equal(notice.id, `jobexit_${job.id}_${job.attempt}`);
    assert.equal(notice.metadata.to_attempt, current.parent_attempt);
    const body = JSON.parse(notice.body);
    assert.equal(body.status, expected);
    assert.equal(body.process_stopped, true);
    if (current.reported_result) {
      assert.equal(body.result_message_id, current.reported_result.message_id);
      assert.deepEqual(wakes(current.reported_result.message_id), [], "semantic report must not wake before stopped evidence");
    }
    assert.equal(receipt.delivery.message_id, notice.id);
    assert.equal(receipt.delivery.status, "submitted");
    const submitted = wakes(notice.id);
    assert.equal(submitted.length, 1);
    const observed = submitted[0].observedJobs.find((item) => item.id === job.id);
    assert.equal(observed.process_stopped, true);
    assert.equal(observed.status, expected);
    assert.equal(submitted[0].params.surface_id, show(current.parent_job).surface_id);
    return { current, receipt };
  }
  t.after(async () => {
    // Cancel through the public boundary, then wait before deleting test-owned
    // state. Fallback signals address only PIDs allocated by this fixture.
    const jobsDir = path.join(root, ".agent-team", "state", "jobs");
    const active = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).filter((file) => file.endsWith(".json")).map((file) => read(path.join(jobsDir, file))) : [];
    try {
      for (const job of active.filter((job) => ["launching", "running", "cancelling"].includes(job.status))) {
        raw(["job", "cancel", job.id]);
        await until(() => jobState(job.id), (value) => value.process_stopped, `cleanup ${job.id}`);
      }
    } finally {
      for (const job of active) {
        if (!jobState(job.id)?.process_stopped && job.surface_id) {
          const log = path.join(directory, `${job.surface_id}.log`);
          if (fs.existsSync(log)) t.diagnostic(fs.readFileSync(log, "utf8"));
        }
      }
      for (const job of active) {
        if (job.pid && !jobState(job.id)?.process_stopped) {
          try { process.kill(-job.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      }
      for (const name of fs.readdirSync(directory).filter((name) => /^runner-\d+\.json$/.test(name))) {
        try { process.kill(read(path.join(directory, name)).pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  return { directory, root, repo, model, env, git, starter, raw, run, json, show, read, boot, command, mcp, holdRunner, ready, launch, create, stopped };
}

test("receipt publication retries incomplete JSON within a bounded deadline", async (t) => {
  const directory = tempRoot();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "exit.json");
  fs.writeFileSync(file, "");
  const expected = { process_stopped: true, delivery: { status: "submitted" } };
  const publication = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    fs.writeFileSync(file, '{"process_stopped":');
    await new Promise((resolve) => setTimeout(resolve, 40));
    publishJson(file, expected);
  })();
  assert.deepEqual(await publishedReceipt(file), expected);
  await publication;
  fs.writeFileSync(file, "{");
  await assert.rejects(publishedReceipt(file, 60), /Timed out waiting for lifecycle delivery receipt/);
  fs.unlinkSync(file);
  await assert.rejects(publishedReceipt(file, 60), /Timed out waiting for lifecycle delivery receipt/);
  await assert.rejects(publishedReceipt(path.join(file, "\0")), /null bytes/);
});

test("integration: startup, durable task/reply, stopped worker, candidate checks and independent review survive CLI restart", { timeout: 45000 }, async (t) => {
  const f = fixture(t);
  const initial = f.starter();
  assert.equal(initial.job.status, "launching");
  const lead = await f.ready(initial.job);
  const leadBoot = await f.boot(lead);
  assert.equal(leadBoot.argv[leadBoot.argv.indexOf("--model") + 1], "gpt-6-astra");
  assert.ok(leadBoot.argv.includes('model_reasoning_effort="xhigh"'));
  assert.equal(leadBoot.argv[leadBoot.argv.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(leadBoot.argv[leadBoot.argv.indexOf("--ask-for-approval") + 1], "on-request");
  const restart = f.starter();
  assert.equal(restart.reused, true);
  assert.equal(restart.job.id, lead.id);
  assert.equal(restart.job.surface_id, lead.surface_id);
  const feature = f.run(["feature", "create", "--json", f.json({
    id: "answer", repo: f.repo, leader: "codex", brief: "Return 42 from answer() without changing other behavior.",
    review_jobs: ["review"], checks: [{ id: "behavior", command: [process.execPath, "check.js"] }]
  })]);
  const workerCwd = path.join(f.directory, "worker checkout");
  f.git(f.repo, "worktree", "add", "-b", "codex/worker", workerCwd, "HEAD");
  const assigned = f.create("worker", { cwd: workerCwd, writable: true, feature_id: feature.id });
  assert.equal(assigned.parent_job, lead.id, "one active lead supplies the parent assignment");
  const worker = f.launch("worker");
  assert.equal(worker.parent_attempt, lead.attempt);
  await f.boot(worker);
  assert.equal(f.run(["job", "wait", worker.id, "--until", "ready", "--timeout-ms", "20"], 1).reached, false);
  assert.equal(f.show(worker.id).status, "launching");
  // An allocation cannot claim readiness; pending delivery still stores the task.
  const sent = await f.mcp(lead, "team_send", { to_job: worker.id, body: "Set answer() to 42. Reply with the commit and focused check." });
  assert.equal(sent.delivery.status, "pending");
  assert.equal(sent.delivery.reason, "recipient_not_ready");
  await f.ready(worker);
  assert.equal(f.run(["job", "wait", worker.id, "--until", "ready", "--timeout-ms", "1000"]).reached, true);
  assert.equal(f.run(["status"]).jobs.find((job) => job.job_id === worker.id).state, "ready");
  assert.equal((await f.mcp(worker, "team_inbox", {})).messages[0].id, sent.message.id);
  const wake = f.run(["job", "wake", worker.id, "--message", sent.message.id]);
  assert.equal(wake.status, "submitted");
  assert.equal(wake.semantic_reply_confirmed, false);
  assert.deepEqual((await f.mcp(lead, "team_inbox", {})).messages, []);
  const reply = await f.mcp(worker, "team_reply", { in_reply_to: sent.message.id, body: "I will implement answer() in my assigned checkout." });
  assert.equal(reply.message.in_reply_to, sent.message.id);
  assert.equal(reply.message.metadata.from_attempt, worker.attempt);
  assert.equal((await f.mcp(lead, "team_inbox", {})).messages[0].body, "I will implement answer() in my assigned checkout.");

  // The fixture supplies a model's edit/commit, while actual Git assembly and
  // candidate checks below must prove its behavior and unchanged source.
  fs.writeFileSync(path.join(workerCwd, "answer.js"), "module.exports = () => 42;\n");
  f.git(workerCwd, "add", "answer.js");
  f.git(workerCwd, "commit", "-m", "Satisfy the isolated answer contract\n\nScope-risk: narrow\nNot-tested: native model reasoning");
  const commit = f.git(workerCwd, "rev-parse", "HEAD");
  await f.holdRunner(worker, async () => {
    const report = await f.mcp(worker, "team_report", { status: "completed", result: JSON.stringify({ commit }), in_reply_to: sent.message.id });
    assert.equal(report.job.status, "running");
    assert.equal(report.job.process_stopped, false);
    assert.equal(report.job.reported_result.message_id, report.message.id);
    assert.equal(report.delivery.reason, "waiting_for_process_stop");
    // Deliberately outlast the production report grace; the barrier, not a fast
    // CI host, must preserve the live process for every assertion below.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(f.run(["status"]).jobs.find((job) => job.job_id === worker.id).state, "stopping");
    f.create("next-writer", { cwd: workerCwd, writable: true });
    assert.match(f.launch("next-writer", 1).stderr, /writer/);
  });
  const finished = await f.stopped(worker, "completed");
  assert.equal(finished.current.reported_result.result, JSON.stringify({ commit }));
  assert.equal(finished.receipt.observed_processes.some((row) => row.pid === finished.receipt.pid), true);
  f.run(["feature", "assemble", feature.id, "--json", f.json({ commit, worker_cwd: workerCwd, allowed_paths: ["answer.js"] })]);
  const { candidate } = f.run(["feature", "snapshot", feature.id]);
  assert.equal(f.run(["feature", "status", feature.id], 1).eligible, false);
  assert.equal(f.run(["feature", "check", feature.id]).status, "completed");
  assert.equal(f.run(["feature", "status", feature.id], 1).eligible, false);
  f.create("review", { role: "review", model: "claude-fable-5-1[1m]", cwd: feature.cwd, writable: false, feature_id: feature.id });
  const review = await f.ready(f.launch("review"));
  assert.equal(review.runtime, "claude");
  const reviewBoot = await f.boot(review);
  assert.equal(reviewBoot.argv[reviewBoot.argv.indexOf("--effort") + 1], "medium");
  const settings = JSON.parse(reviewBoot.argv[reviewBoot.argv.indexOf("--settings") + 1]);
  assert.equal(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "1");
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "1");
  assert.equal(settings.switchModelsOnFlag, false);
  assert.equal(reviewBoot.argv[reviewBoot.argv.indexOf("--permission-mode") + 1], "dontAsk");
  const reviewPacket = fs.readFileSync(path.join(f.root, ".agent-team", "sessions", review.id, "1", "candidate.diff"), "utf8");
  assert.match(reviewPacket, /\+module.exports = \(\) => 42/);
  const reviewResult = { candidate, brief_hash: candidate.brief_hash, verdict: "approve", findings: [] };
  await f.holdRunner(review, async () => {
    await f.mcp(review, "team_report", { status: "completed", result: JSON.stringify(reviewResult), to_job: lead.id });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const pending = f.run(["feature", "collect", feature.id], 1);
    assert.equal(pending.eligible, false);
    assert.deepEqual(pending.pending, [{ job_id: review.id, attempt: 1, status: "running", result_reported: true }]);
    assert.deepEqual(pending.reviews, []);
    assert.deepEqual(pending.errors, []);
  });
  await f.stopped(review, "completed");
  const collected = f.run(["feature", "collect", feature.id]);
  assert.equal(collected.eligible, true);
  assert.deepEqual(collected.pending, []);
  assert.deepEqual(collected.errors, []);
  assert.equal(collected.reviews.length, 1);
  assert.equal(collected.reviews[0].attempt, 1);
  assert.equal(collected.reviews[0].reviewer_job_id, review.id);
  assert.deepEqual(f.run(["feature", "collect", feature.id]), collected);
  const featureState = path.join(f.root, ".agent-team", "state", "features", `${feature.id}.json`);
  assert.deepEqual(f.read(featureState).reviews, collected.reviews);
  assert.equal(f.starter().reused, true);
  assert.deepEqual(f.run(["feature", "collect", feature.id]), collected);
  assert.equal(f.git(f.repo, "show", "HEAD:answer.js"), "module.exports = () => 0;");
  assert.equal(f.git(feature.cwd, "status", "--porcelain"), "");

  // A replacement review invalidates approval immediately, even with unchanged
  // candidate source. Cancellation cannot resurrect attempt one's result.
  const retry = await f.ready(f.launch(review.id));
  assert.equal(retry.attempt, 2);
  const replacing = f.run(["feature", "collect", feature.id], 1);
  assert.equal(replacing.eligible, false);
  assert.deepEqual(replacing.pending, [{ job_id: retry.id, attempt: 2, status: "running", result_reported: false }]);
  assert.deepEqual(replacing.reviews, []);
  assert.deepEqual(replacing.errors, []);
  assert.deepEqual(f.read(featureState).reviews, collected.reviews);
  f.run(["job", "cancel", retry.id]);
  await f.stopped(retry, "cancelled");
  const cancelled = f.run(["feature", "collect", feature.id], 1);
  assert.equal(cancelled.eligible, false);
  assert.deepEqual(cancelled.pending, []);
  assert.deepEqual(cancelled.reviews, []);
  assert.equal(cancelled.errors.length, 1);
  assert.equal(cancelled.errors[0].job_id, retry.id);
  assert.equal(cancelled.errors[0].attempt, 2);
  assert.match(cancelled.errors[0].error, /cancelled/);
  const fresh = await f.ready(f.launch(review.id));
  assert.equal(fresh.attempt, 3);
  await f.mcp(fresh, "team_report", { status: "completed", result: JSON.stringify(reviewResult), to_job: lead.id });
  await f.stopped(fresh, "completed");
  const recollected = f.run(["feature", "collect", feature.id]);
  assert.equal(recollected.eligible, true);
  assert.deepEqual(recollected.pending, []);
  assert.deepEqual(recollected.errors, []);
  assert.equal(recollected.reviews.length, 1);
  assert.equal(recollected.reviews[0].reviewer_job_id, fresh.id);
  assert.equal(recollected.reviews[0].attempt, 3);
  assert.equal(recollected.reviews[0].verdict, reviewResult.verdict);
  assert.deepEqual(f.run(["feature", "collect", feature.id]), recollected);
  const state = f.read(featureState);
  assert.deepEqual(state.reviews, [...collected.reviews, ...recollected.reviews]);
  fs.appendFileSync(state.check_runs.at(-1).results[0].stdout_path, "changed evidence");
  assert.match(f.run(["feature", "status", feature.id], 1).reasons.join("\n"), /check evidence changed/);
  // A valid old review cannot be imported against a new frozen candidate, and
  // the behavioral check must actually reject a broken replacement patch.
  fs.writeFileSync(path.join(feature.cwd, "answer.js"), "module.exports = () => 43;\n");
  f.git(feature.cwd, "add", "answer.js");
  f.git(feature.cwd, "commit", "-m", "Exercise rejection of changed candidate behavior\n\nScope-risk: narrow\nTested: stale review and behavioral failure gates");
  const changed = f.run(["feature", "snapshot", feature.id]);
  assert.notEqual(changed.candidate.commit, candidate.commit);
  const stale = f.run(["feature", "collect", feature.id], 1);
  assert.equal(stale.eligible, false);
  assert.deepEqual(stale.pending, []);
  assert.deepEqual(stale.reviews, []);
  assert.equal(stale.errors.length, 1);
  assert.equal(stale.errors[0].job_id, fresh.id);
  assert.match(stale.errors[0].error, /stale/);
  assert.deepEqual(f.read(featureState).reviews, state.reviews);
  assert.equal(f.run(["feature", "check", feature.id], 1).status, "failed");
  assert.equal(f.run(["feature", "status", feature.id], 1).eligible, false);
});

test("integration: failed wake keeps one durable message; abrupt model exit releases only observed stopped processes and fences retries", { timeout: 30000 }, async (t) => {
  const f = fixture(t);
  const lead = await f.ready(f.starter().job);
  f.create("worker", { writable: true });
  const worker = await f.ready(f.launch("worker"));
  const boot = await f.boot(worker);
  fs.writeFileSync(path.join(f.directory, "wake-unavailable"), "fixture failure");
  const message = f.run(["job", "send", lead.id, "--json", f.json({ to_job: worker.id, body: "Durable request across unavailable wake" })]);
  assert.equal(message.delivery.status, "failed");
  assert.match(message.delivery.error, /unavailable/);
  assert.equal(f.starter().reused, true);
  const inbox = await f.mcp(worker, "team_inbox", {});
  assert.deepEqual(inbox.messages.map((item) => item.id), [message.message.id]);
  fs.unlinkSync(path.join(f.directory, "wake-unavailable"));
  assert.equal(f.run(["job", "wake", worker.id, "--message", message.message.id]).semantic_reply_confirmed, false);
  assert.equal((await f.mcp(worker, "team_inbox", {})).messages.length, 1);
  // Ensure the real runner has observed the MCP descendant before crashing its
  // native parent; detached/unobserved descendants remain a separate live gate.
  await new Promise((resolve) => setTimeout(resolve, 600));
  await f.command(worker, { exit: 23 });
  const { current, receipt } = await f.stopped(worker, "failed");
  assert.equal(receipt.code, 23);
  assert.equal(current.reported_result, undefined);
  assert.match(current.result, /23/);
  assert.equal(receipt.observed_processes.some((row) => row.pid === boot.mcp_pid), true);
  assert.throws(() => process.kill(boot.mcp_pid, 0), { code: "ESRCH" });
  const retry = await f.ready(f.launch(worker.id));
  assert.equal(retry.attempt, 2);
  assert.deepEqual((await f.mcp(retry, "team_inbox", {})).messages, []);
  assert.match(f.raw(["job", "wake", worker.id, "--message", message.message.id], 1).stderr, /not in current addressed inbox/);
  const stale = spawnSync(process.execPath, [require.resolve("../src/team/sessionMcp"), "--cwd", f.root, "--job", worker.id, "--attempt", "1"], {
    env: f.env, input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n", encoding: "utf8", timeout: 5000
  });
  assert.ifError(stale.error);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale/);
  assert.equal(f.show(worker.id).attempt, 2);
});
