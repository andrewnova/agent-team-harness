const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { tempRoot } = require("./helpers");
const jobs = require("../src/team/jobs");
const mailbox = require("../src/mailbox");

const runner = require.resolve("../src/team/sessionRunner");
const mcp = require.resolve("../src/team/sessionMcp");
const workspace = "11111111-1111-4111-8111-111111111111";
const surfaces = {
  parent: "22222222-2222-4222-8222-222222222222",
  other: "33333333-3333-4333-8333-333333333333",
  worker: "44444444-4444-4444-8444-444444444444"
};

async function until(read, predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let current;
  while (Date.now() < deadline) {
    current = read();
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(current)}`);
}

// This function is serialized into a disposable native-model executable. The
// real runner owns it and its real JSON-lines MCP subprocess; no model is used.
async function nativeFixture() {
  const fs = require("node:fs");
  const readline = require("node:readline");
  const { spawn } = require("node:child_process");
  const config = JSON.parse(process.argv[2]);
  fs.appendFileSync(config.starts, JSON.stringify({ pid: process.pid }) + "\n");
  const server = spawn(process.execPath, [config.mcp, "--cwd", config.root, "--job", "worker", "--attempt", String(config.attempt)], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let sequence = 0;
  readline.createInterface({ input: server.stdout }).on("line", (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });
  function request(method, params) {
    const id = ++sequence;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function tool(name, args) {
    return request("tools/call", { name, arguments: args, _meta: { threadId: `recovery-worker-${config.attempt}` } });
  }
  await request("initialize", { protocolVersion: "2024-11-05" });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const ready = await tool("team_report", { status: "ready" });
  fs.writeFileSync(config.ready, JSON.stringify({ ready, mcp_pid: server.pid }));
  let next = 1;
  let busy = false;
  const timer = setInterval(async () => {
    const file = `${config.control}.${next}.json`;
    if (busy || !fs.existsSync(file)) return;
    busy = true;
    const action = JSON.parse(fs.readFileSync(file));
    if (action.report) {
      const response = await tool("team_report", action.report);
      fs.writeFileSync(`${config.control}.${next}.response.json`, JSON.stringify(response));
    }
    if (action.exit !== undefined) process.exit(action.exit);
    next++;
    busy = false;
  }, 10);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    server.stdin.end();
    server.once("close", () => process.exit(config.stopExitCode ?? 0));
  });
  setTimeout(() => process.exit(124), 30000).unref();
}

function fixture(t) {
  const root = fs.realpathSync(tempRoot());
  const preload = path.join(root, "external-boundary.cjs");
  const model = path.join(root, "native-fixture.cjs");
  const started = path.join(root, "started.jsonl");
  const wakeLog = path.join(root, "wakes.jsonl");
  const wakeFailure = path.join(root, "wake-failure");
  const bindingFailure = path.join(root, "binding-failure.json");
  const workerFile = path.join(root, ".agent-team", "state", "jobs", "worker.json");
  const handles = [];
  fs.writeFileSync(model, `(${nativeFixture.toString()})().catch(error => { console.error(error); process.exit(1); });\n`);
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const cp = require('node:child_process');
    const root = ${JSON.stringify(root)};
    const jobDirectory = path.join(root, '.agent-team', 'state', 'jobs');
    const readJobs = () => fs.readdirSync(jobDirectory).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(jobDirectory, name))));
    for (const method of ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec']) {
      const original = cp[method];
      cp[method] = (file, ...args) => {
        if (path.basename(file) === 'cmux' && method === 'spawnSync') {
          const argv = args[0];
          if (argv.slice(0, 4).join(' ') !== '--json --id-format uuids rpc') throw new Error('Unexpected cmux command');
          const operation = argv[4];
          const params = JSON.parse(argv[5]);
          const current = readJobs();
          let result = { workspace_id: params.workspace_id, surface_id: params.surface_id };
          if (operation === 'surface.list') {
            result.surfaces = current.filter(job => job.workspace_id === params.workspace_id && job.surface_id).map(job => ({ id: job.surface_id, type: 'terminal' }));
          } else if (['surface.send_text', 'surface.send_key'].includes(operation)) {
            const from = current.find(job => job.id === 'worker');
            const to = current.find(job => job.surface_id === params.surface_id);
            const failed = fs.existsSync(${JSON.stringify(wakeFailure)});
            fs.appendFileSync(${JSON.stringify(wakeLog)}, JSON.stringify({ operation, params, from, to, failed }) + '\\n');
            if (failed) return { status: 1, stdout: '', stderr: 'fixture wake unavailable' };
          } else throw new Error('Unexpected cmux operation: ' + operation);
          return { status: 0, stdout: JSON.stringify(result), stderr: '' };
        }
        if (![process.execPath, 'ps', path.join(root, 'missing-native')].includes(file)) throw new Error('Unexpected external execution: ' + file);
        return original(file, ...args);
      };
    }
    // Inject a real persistence error at the PID-binding write after spawn,
    // without replacing claimRunner, bindJob, or process-stopped accounting.
    if (process.env.TEAM_RECOVERY_FAIL_BIND === '1' && process.argv[1] === ${JSON.stringify(runner)}) {
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to === ${JSON.stringify(workerFile)}) {
          const record = JSON.parse(fs.readFileSync(from));
          if (record.pid) {
            fs.writeFileSync(${JSON.stringify(bindingFailure)}, JSON.stringify({ pid: record.pid }));
            throw Object.assign(new Error('fixture PID binding write failed'), { code: 'EIO' });
          }
        }
        return rename(from, to);
      };
    }
  `);
  const env = { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, AGENT_TEAM_HEADLESS: "1",
    CMUX_WORKSPACE_ID: workspace, CMUX_SURFACE_ID: surfaces.worker };
  for (const key of Object.keys(env)) {
    if (key === "CODEX_THREAD_ID" || key.startsWith("CLAUDE") ||
        (key.startsWith("CMUX_") && !["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID"].includes(key))) delete env[key];
  }
  const read = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
  const rows = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  function create(id, role, input = {}) {
    return jobs.createJob(root, { id, leader: "codex", role, model: "gpt-6-astra", cwd: root,
      writable: role === "backend", prompt: "Deterministic runner recovery fixture", ...input });
  }
  for (const id of ["parent", "other"]) {
    create(id, "lead");
    jobs.claimJob(root, id, { max_active: 4 });
    jobs.bindJob(root, id, 1, { workspace_id: workspace, surface_id: surfaces[id], ready: true });
  }
  create("worker", "backend", { parent_job: "parent" });
  const claim = () => jobs.claimJob(root, "worker", { max_active: 4 });
  const show = () => jobs.getJob(root, "worker");
  function packet(job, argv, nativeOptions = {}) {
    const dir = path.join(root, ".agent-team", "sessions", "worker", String(job.attempt));
    fs.mkdirSync(dir, { recursive: true });
    const control = path.join(dir, "action");
    const ready = path.join(dir, "ready.json");
    const file = path.join(dir, "launch.json");
    fs.writeFileSync(file, JSON.stringify({ root, job_id: job.id, attempt: job.attempt, cwd: root,
      argv: argv || [process.execPath, model, JSON.stringify({ root, attempt: job.attempt, starts: started, ready, control, mcp, ...nativeOptions })] }));
    return { file, control, ready, receipt: path.join(dir, "exit.json"), attempt: job.attempt, sequence: 0 };
  }
  function launch(packet, options = {}) {
    const child = spawn(process.execPath, [runner, packet.file], { env: { ...env, ...options }, stdio: ["ignore", "pipe", "pipe"] });
    const handle = { child, output: "", ended: null };
    child.stdout.on("data", (data) => { handle.output += data; });
    child.stderr.on("data", (data) => { handle.output += data; });
    child.on("error", (error) => { handle.error = error; });
    child.on("close", (code, signal) => { handle.ended = { code, signal }; });
    handles.push(handle);
    return handle;
  }
  async function end(handle, expected = 0) {
    await until(() => handle.ended, Boolean, `runner exit (${handle.output})`);
    assert.ifError(handle.error);
    assert.equal(handle.ended.code, expected, handle.output);
    return handle.ended;
  }
  async function ready(packet) {
    const value = await until(() => read(packet.ready), Boolean, "native ready");
    assert.equal(JSON.parse(value.ready.result.content[0].text).ok, true);
    assert.equal(show().status, "running");
    return value;
  }
  async function action(packet, input) {
    const index = ++packet.sequence;
    fs.writeFileSync(`${packet.control}.${index}.json`, JSON.stringify(input));
    if (!input.report) return;
    const response = await until(() => read(`${packet.control}.${index}.response.json`), Boolean, "semantic report");
    const result = JSON.parse(response.result.content[0].text);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.report_error, undefined);
    return result;
  }
  function notify(attempt, expected = 0) {
    const result = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require(process.argv[1]).notifyResult(process.argv[2], 'worker', Number(process.argv[3]))))", runner, root, String(attempt)], { env, encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr);
    return expected === 0 ? JSON.parse(result.stdout) : result.stderr;
  }
  function stopped(packet, status) {
    const job = show();
    const receipt = read(packet.receipt);
    assert.equal(job.status, status);
    assert.equal(job.process_stopped, true);
    assert.equal(receipt.process_stopped, true);
    assert.equal(receipt.attempt, packet.attempt);
    assert.deepEqual(receipt.remaining, []);
    if (receipt.pid) assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" });
    const notices = mailbox.listMessages(root).filter((message) => message.metadata?.event === "job_stopped" &&
      message.metadata.from_job === "worker" && message.metadata.from_attempt === packet.attempt);
    assert.equal(notices.length, 1, "one durable lifecycle notice per stopped attempt");
    assert.equal(notices[0].id, `jobexit_worker_${packet.attempt}`);
    assert.equal(notices[0].metadata.to_job, "parent");
    assert.equal(notices[0].metadata.to_attempt, job.parent_attempt);
    for (const row of rows(wakeLog)) {
      assert.equal(row.from.process_stopped, true, "completion cannot wake before releasing ownership");
      assert.equal(row.to.id, "parent", "only the assigned parent receives lifecycle wakes");
      assert.equal(row.to.attempt, row.from.parent_attempt);
    }
    return receipt;
  }
  const notices = (parent = "parent", attempt = 1) => jobs.jobInbox(root, parent, attempt).filter((message) => message.metadata.event === "job_stopped");
  t.after(async () => {
    try {
      if (handles.some((handle) => !handle.ended) && ["launching", "running", "cancelling"].includes(show().status)) jobs.cancelJob(root, "worker", show().attempt);
      for (const handle of handles) {
        if (!handle.ended) await until(() => handle.ended, Boolean, `fixture cleanup: ${handle.output}`);
      }
    } finally {
      for (const handle of handles) if (!handle.ended) handle.child.kill("SIGKILL");
      const job = show();
      if (job.pid && !job.process_stopped) {
        try { process.kill(-job.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, env, claim, show, packet, launch, end, ready, action, notify, stopped, notices, read,
    starts: () => rows(started), wakes: () => rows(wakeLog), wakeFailure, bindingFailure };
}

test("runner recovery: simultaneous duplicate runners admit one native child and retain the winner", { timeout: 20000 }, async (t) => {
  const f = fixture(t);
  const packet = f.packet(f.claim());
  const runners = [f.launch(packet), f.launch(packet)];
  await f.ready(packet);
  await until(() => runners.find((handle) => handle.ended), Boolean, "duplicate rejection");
  const duplicate = runners.find((handle) => handle.ended);
  assert.equal(duplicate.ended.code, 1, duplicate.output);
  assert.match(duplicate.output, /already has a runner/);
  const owner = runners.find((handle) => !handle.ended);
  assert.equal(f.show().runner_pid, owner.child.pid);
  assert.equal(f.starts().length, 1);
  assert.equal(f.read(packet.receipt), null, "loser must not publish exit evidence for winner");
  jobs.cancelJob(f.root, "worker", 1);
  await f.end(owner);
  f.stopped(packet, "cancelled");
  assert.equal(f.starts().length, 1);
});

test("runner recovery: cancellation before startup spawns no native process and releases the claim", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const packet = f.packet(f.claim());
  jobs.cancelJob(f.root, "worker", 1);
  const child = f.launch(packet);
  await f.end(child);
  const receipt = f.stopped(packet, "cancelled");
  assert.equal(receipt.pid, undefined);
  assert.deepEqual(f.starts(), []);
  assert.equal(JSON.parse(f.notices()[0].body).status, "cancelled");
  assert.equal(f.claim().attempt, 2);
});

test("runner recovery: missing binary fails, notifies its parent, and releases ownership", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  // Exercise a real ENOENT at the external native executable boundary.
  const missing = path.join(f.root, "missing-native");
  const packet = f.packet(f.claim(), [missing]);
  const child = f.launch(packet);
  await f.end(child);
  const receipt = f.stopped(packet, "failed");
  assert.match(receipt.error, /ENOENT/);
  assert.equal(receipt.pid, undefined);
  assert.deepEqual(f.starts(), []);
  assert.equal(f.notices().length, 1);
  assert.equal(f.claim().attempt, 2);
});

test("runner recovery: a PID binding persistence failure after spawn cleans the child before releasing", { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  const packet = f.packet(f.claim());
  const child = f.launch(packet, { TEAM_RECOVERY_FAIL_BIND: "1" });
  await f.end(child);
  const receipt = f.stopped(packet, "failed");
  const injected = f.read(f.bindingFailure);
  assert.ok(injected.pid > 0, "fault must occur after an actual native spawn");
  assert.equal(receipt.pid, injected.pid);
  assert.match(receipt.error, /PID binding write failed/);
  assert.throws(() => process.kill(injected.pid, 0), { code: "ESRCH" });
  assert.equal(f.notices().length, 1);
  assert.equal(f.claim().attempt, 2);
});

for (const [label, status, exit, expected] of [
  ["completion", "completed", 0, "completed"],
  ["semantic failure", "failed", 0, "failed"],
  ["abrupt failure after a completion report", "completed", 23, "failed"]
]) {
  test(`runner recovery: ${label} reaches only the assigned parent after process_stopped`, { timeout: 15000 }, async (t) => {
    const f = fixture(t);
    const packet = f.packet(f.claim());
    const child = f.launch(packet);
    await f.ready(packet);
    const report = { status, result: "Fixture semantic result", to_job: "parent" };
    const response = await f.action(packet, { report });
    assert.equal(response.job.process_stopped, false);
    assert.equal(response.job.reported_result.message_id, response.message.id);
    assert.deepEqual(response.delivery, { status: "pending", reason: "waiting_for_process_stop" });
    assert.throws(() => jobs.jobFinishedMessage(f.root, "worker", 1), /must have stopped/);
    assert.deepEqual(f.wakes(), []);
    assert.deepEqual(f.notices(), []);
    const repeated = await f.action(packet, { report });
    assert.equal(repeated.message.id, response.message.id, "semantic retry must reuse its addressed result");
    assert.equal(jobs.jobInbox(f.root, "parent", 1).filter((message) => message.id === response.message.id).length, 1);
    await f.action(packet, { exit });
    await f.end(child);
    const receipt = f.stopped(packet, expected);
    assert.equal(receipt.code, exit);
    const [notice] = f.notices();
    assert.ok(notice);
    assert.deepEqual(JSON.parse(notice.body), { job_id: "worker", attempt: 1, status: expected, process_stopped: true, result_message_id: response.message.id });
    assert.equal(receipt.delivery.message_id, notice.id);
    assert.equal(receipt.delivery.status, "submitted");
    assert.deepEqual(f.notices("other"), []);
    assert.equal(f.wakes().filter((row) => row.operation === "surface.send_text").length, 1);
  });
}

for (const [stopExitCode, expected] of [[0, "completed"], [23, "failed"]]) {
  test(`runner recovery: report-driven shutdown with native exit ${stopExitCode} finishes as ${expected}`, { timeout: 15000 }, async (t) => {
    const f = fixture(t);
    const packet = f.packet(f.claim(), undefined, { stopExitCode });
    const child = f.launch(packet);
    await f.ready(packet);
    await f.action(packet, { report: { status: "completed", result: "Semantic completion before supervisor shutdown", to_job: "parent" } });
    // The native session remains open, as an interactive CLI normally does.
    // Only the real runner initiates shutdown after its report grace period.
    await f.end(child);
    const receipt = f.stopped(packet, expected);
    assert.equal(receipt.code, stopExitCode);
    assert.equal(JSON.parse(f.notices()[0].body).status, expected);
  });
}

test("runner recovery: failed notification retries reuse one durable ID and cannot leak across either job attempt", { timeout: 20000 }, async (t) => {
  const f = fixture(t);
  const packet = f.packet(f.claim());
  const child = f.launch(packet);
  await f.ready(packet);
  fs.writeFileSync(f.wakeFailure, "unavailable");
  await f.action(packet, { exit: 19 });
  await f.end(child);
  const receipt = f.stopped(packet, "failed");
  assert.equal(receipt.code, 19);
  assert.equal(receipt.delivery.status, "failed");
  const [notice] = f.notices();
  assert.ok(notice);
  assert.equal(JSON.parse(notice.body).status, "failed");
  assert.match(JSON.parse(notice.body).result, /19/);
  fs.unlinkSync(f.wakeFailure);
  for (let i = 0; i < 2; i++) {
    const retry = f.notify(1);
    assert.equal(retry.message_id, notice.id);
    assert.equal(retry.status, "submitted");
  }
  assert.equal(f.notices().length, 1);
  assert.equal(mailbox.listMessages(f.root).filter((message) => message.id === notice.id).length, 1);
  const firstWakeCount = f.wakes().length;
  const nextWorker = f.claim();
  assert.equal(nextWorker.attempt, 2);
  assert.equal(nextWorker.parent_attempt, 1);
  assert.deepEqual(f.notices(), [], "old sender-attempt notices must leave the parent's current inbox");
  assert.match(f.notify(1, 1), /stale/);
  assert.equal(f.wakes().length, firstWakeCount);
  const secondPacket = f.packet(nextWorker, [path.join(f.root, "missing-native")]);
  await f.end(f.launch(secondPacket));
  f.stopped(secondPacket, "failed");
  assert.equal(f.notices()[0].metadata.from_attempt, 2);
  assert.notEqual(f.notices()[0].id, notice.id);
  const wakeCount = f.wakes().length;
  jobs.finishJob(f.root, "parent", 1, { status: "cancelled", process_stopped: true });
  jobs.claimJob(f.root, "parent", { max_active: 4 });
  jobs.bindJob(f.root, "parent", 2, { workspace_id: workspace, surface_id: surfaces.parent, ready: true });
  assert.deepEqual(f.notify(2), { status: "pending", reason: "parent_attempt_not_active" });
  assert.deepEqual(f.notices("parent", 2), []);
  assert.equal(f.wakes().length, wakeCount);
  const retry = f.claim();
  assert.equal(retry.attempt, 3);
  assert.equal(retry.parent_attempt, 2);
  assert.equal(retry.runner_pid, undefined);
  assert.equal(retry.reported_result, undefined);
  assert.match(f.notify(2, 1), /stale/);
  assert.deepEqual(f.notices("parent", 2), []);
  assert.equal(f.wakes().length, wakeCount);
});
