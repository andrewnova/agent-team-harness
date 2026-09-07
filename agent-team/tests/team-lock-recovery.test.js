const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { withLock } = require("../src/team/lock");
const processes = require("../src/team/processes");
const jobs = require("../src/team/jobs");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "team-lock-recovery-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, lock: path.join(root, "start.lock") };
}

const helper = `
  const fs = require('node:fs');
  const path = require('node:path');
  const {withLock} = require(process.argv[1]);
  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  const phase = (name) => {process.send({phase:name}); pause();};
  process.send({phase:'ready'});
  process.once('message', ({lock, mode, counter, jobsPath, root}) => {
    try {
      if (mode === 'legacy') {
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({pid:process.pid, created_at:new Date().toISOString()}));
        phase('held');
      }
      if (mode === 'before-publish' || mode === 'after-publish') {
        const link = fs.linkSync;
        fs.linkSync = (...args) => {
          if (mode === 'before-publish') phase(mode);
          const result = link(...args);
          if (mode === 'after-publish') phase(mode);
          return result;
        };
      }
      if (mode === 'after-retirement') {
        const rename = fs.renameSync;
        fs.renameSync = (...args) => {
          const result = rename(...args);
          if (args[0] === lock) phase(mode);
          return result;
        };
      }
      if (mode === 'job-write') {
        const rename = fs.renameSync;
        fs.renameSync = (...args) => {
          const result = rename(...args);
          if (args[1] === path.join(root, '.agent-team', 'state', 'jobs', 'writer.json')) phase(mode);
          return result;
        };
        require(jobsPath).claimJob(root, 'writer', {max_active:2});
      } else withLock(lock, () => {
        if (mode === 'hold') phase('held');
        if (counter) {
          const inside = counter + '.inside';
          fs.mkdirSync(inside); // Actual overlap fails, independently of count.
          try {
            const count = Number(fs.readFileSync(counter, 'utf8'));
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            fs.writeFileSync(counter, String(count + 1));
          } finally { fs.rmdirSync(inside); }
        }
      }, {timeoutMs:5000});
      process.send({ok:true});
    } catch (error) {process.send({ok:false, error:error.message});}
    process.disconnect();
  });
`;

async function child(t) {
  const proc = spawn(process.execPath, ["-e", helper, require.resolve("../src/team/lock")], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(proc, "exit");
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await exited;
  });
  async function next() {
    const result = await Promise.race([
      once(proc, "message").then(([message]) => message),
      exited.then(([code, signal]) => { throw new Error(`lock helper exited ${code}/${signal}: ${stderr}`); })
    ]);
    return result;
  }
  assert.deepEqual(await next(), { phase: "ready" });
  return {
    async run(input) { const pending = next(); proc.send(input); return pending; },
    async kill() { proc.kill("SIGKILL"); assert.deepEqual(await exited, [null, "SIGKILL"]); },
    pid: proc.pid
  };
}

test("returns values, releases after exceptions, and requires synchronous callbacks", (t) => {
  const { lock } = fixture(t);
  assert.equal(withLock(lock, () => 42), 42);
  assert.equal(fs.existsSync(lock), false);
  const inode = fs.statSync(`${lock}.sqlite`).ino;
  assert.throws(() => withLock(lock, () => { throw new Error("callback failed"); }), /callback failed/);
  assert.equal(withLock(lock, () => "retry"), "retry");
  assert.equal(fs.statSync(`${lock}.sqlite`).ino, inode);
  assert.throws(() => withLock(lock, async () => 1), /synchronous/);
  assert.throws(() => withLock(lock, () => Promise.resolve(1)), /Promise/);
  assert.throws(() => withLock(lock, () => 1, { timeoutMs: -1 }), /timeoutMs/);
});

test("SIGKILL releases a real holder; concurrent recoverers serialize all updates", { timeout: 20000 }, async (t) => {
  const { root, lock } = fixture(t);
  const holder = await child(t);
  assert.deepEqual(await holder.run({ lock, mode: "hold" }), { phase: "held" });
  const marker = fs.readFileSync(lock, "utf8");
  assert.throws(() => withLock(lock, () => assert.fail("active holder stolen"), { timeoutMs: 20 }), /SQLite mutex/);
  assert.equal(fs.readFileSync(lock, "utf8"), marker);
  await holder.kill();
  // Kernel ownership, unlike a PID string, remains definitive without ps.
  t.mock.method(processes, "inventory", () => { throw new Error("inventory unavailable"); });
  const counter = path.join(root, "counter");
  fs.writeFileSync(counter, "0");
  const recoverers = await Promise.all(Array.from({ length: 8 }, () => child(t)));
  assert.deepEqual(await Promise.all(recoverers.map((proc) => proc.run({ lock, counter }))), Array.from({ length: 8 }, () => ({ ok: true })));
  assert.equal(fs.readFileSync(counter, "utf8"), "8");
  assert.equal(fs.existsSync(lock), false);
  assert.equal(withLock(lock, () => "still usable"), "still usable");
});

for (const mode of ["before-publish", "after-publish"]) {
  test(`SIGKILL ${mode} cannot strand a partial owner`, { timeout: 10000 }, async (t) => {
    const { root, lock } = fixture(t);
    const holder = await child(t);
    assert.deepEqual(await holder.run({ lock, mode }), { phase: mode });
    assert.equal(fs.existsSync(lock), mode === "after-publish");
    await holder.kill();
    assert.equal(withLock(lock, () => "recovered"), "recovered");
    assert.equal(fs.existsSync(lock), false);
    assert.ok(fs.readdirSync(root).some((name) => name.endsWith(".tmp")));
  });
}

test("known-dead legacy holder recovers after SIGKILL, including a killed recoverer", { timeout: 15000 }, async (t) => {
  const { root, lock } = fixture(t);
  const holder = await child(t);
  assert.deepEqual(await holder.run({ lock, mode: "legacy" }), { phase: "held" });
  const original = fs.readFileSync(path.join(lock, "owner.json"), "utf8");
  assert.throws(() => withLock(lock, () => assert.fail("legacy holder stolen")), /active or its PID identity is uncertain/);
  assert.equal(fs.readFileSync(path.join(lock, "owner.json"), "utf8"), original);
  await holder.kill();
  const recoverer = await child(t);
  assert.deepEqual(await recoverer.run({ lock, mode: "after-retirement" }), { phase: "after-retirement" });
  assert.equal(fs.existsSync(lock), false);
  await recoverer.kill();
  assert.equal(withLock(lock, () => "recovered"), "recovered");
  const retired = fs.readdirSync(root).find((name) => name.endsWith(".retired"));
  assert.equal(fs.readFileSync(path.join(root, retired, "owner.json"), "utf8"), original);
});

test("simultaneous recoverers reclaim one dead legacy directory safely", { timeout: 15000 }, async (t) => {
  const { root, lock } = fixture(t);
  const holder = await child(t);
  await holder.run({ lock, mode: "legacy" });
  await holder.kill();
  const counter = path.join(root, "counter");
  fs.writeFileSync(counter, "0");
  const recoverers = await Promise.all(Array.from({ length: 6 }, () => child(t)));
  const results = await Promise.all(recoverers.map((proc) => proc.run({ lock, counter })));
  assert.deepEqual(results, Array.from({ length: 6 }, () => ({ ok: true })));
  assert.equal(fs.readFileSync(counter, "utf8"), "6");
});

test("missing, partial, invalid or unobservable legacy owners always fail closed", (t) => {
  const { lock } = fixture(t);
  fs.mkdirSync(lock);
  const file = path.join(lock, "owner.json");
  assert.throws(() => withLock(lock, () => assert.fail()), /missing/);
  for (const raw of ["{", "{}", "null", '{"pid":0}', '{"pid":12,"started":null}']) {
    fs.writeFileSync(file, raw);
    assert.throws(() => withLock(lock, () => assert.fail()), /unreadable|incomplete/);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
  const raw = JSON.stringify({ pid: 1234567, created_at: "1970-01-01T00:00:00Z" });
  fs.writeFileSync(file, raw);
  const unavailable = t.mock.method(processes, "inventory", () => { throw new Error("ps failed"); });
  assert.throws(() => withLock(lock, () => assert.fail()), /inventory is unavailable/);
  unavailable.mock.restore();
  t.mock.method(processes, "inventory", () => []);
  assert.throws(() => withLock(lock, () => assert.fail()), /inventory is incomplete/);
  assert.equal(fs.readFileSync(file, "utf8"), raw);
});

test("a live legacy PID is uncertain even with a different start time or ancient age", (t) => {
  const { lock } = fixture(t);
  fs.mkdirSync(lock);
  const raw = JSON.stringify({ pid: process.pid, started: "different timezone or reused PID", created_at: "1970-01-01T00:00:00Z" });
  fs.writeFileSync(path.join(lock, "owner.json"), raw);
  t.mock.method(processes, "inventory", () => [{ pid: process.pid, started: "current incarnation" }]);
  assert.throws(() => withLock(lock, () => assert.fail()), /PID identity is uncertain/);
  assert.equal(fs.readFileSync(path.join(lock, "owner.json"), "utf8"), raw);
});

test("a legacy mkdir racing publication wins without being removed", (t) => {
  const { lock } = fixture(t);
  const original = fs.linkSync;
  t.mock.method(fs, "linkSync", (from, to) => {
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, "owner.json"), JSON.stringify({ pid: process.pid }));
    return original(from, to);
  });
  assert.throws(() => withLock(lock, () => assert.fail()), /another legacy operation/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).pid, process.pid);
});

test("release fences both replaced inodes and changed owner tokens", (t) => {
  const { lock } = fixture(t);
  for (const replace of [false, true]) {
    let replacement;
    assert.throws(() => withLock(lock, () => {
      const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
      owner.token = "replacement-owner";
      replacement = JSON.stringify(owner);
      if (replace) fs.renameSync(lock, `${lock}.old`);
      fs.writeFileSync(lock, replacement);
    }), /ownership changed before release/);
    assert.equal(fs.readFileSync(lock, "utf8"), replacement);
    assert.equal(withLock(lock, () => "retry"), "retry");
  }
});

test("corrupted markers and replaced or aliased SQLite files fail visibly", (t) => {
  const { root, lock } = fixture(t);
  fs.writeFileSync(lock, "{");
  assert.throws(() => withLock(lock, () => assert.fail()), /unreadable/);
  fs.unlinkSync(lock);
  let marker;
  withLock(lock, () => { marker = fs.readFileSync(lock, "utf8"); });
  fs.writeFileSync(lock, marker);
  const db = `${lock}.sqlite`;
  fs.renameSync(db, `${db}.old`);
  assert.throws(() => withLock(lock, () => assert.fail()), /changed SQLite mutex/);
  assert.equal(fs.readFileSync(lock, "utf8"), marker);
  fs.unlinkSync(db);
  fs.symlinkSync(`${db}.old`, db);
  assert.throws(() => withLock(lock, () => assert.fail()), /unaliased/);
  fs.unlinkSync(db);
  fs.linkSync(`${db}.old`, db);
  assert.throws(() => withLock(lock, () => assert.fail()), /unaliased/);
  fs.symlinkSync(root, path.join(root, "alias"));
  assert.throws(() => withLock(path.join(root, "alias", "other.lock"), () => assert.fail()), /canonical/);
});

test("closing a same-process contender cannot release the outer SQLite lock", (t) => {
  const { lock } = fixture(t);
  withLock(lock, () => {
    assert.throws(() => withLock(lock, () => assert.fail(), { timeoutMs: 0 }), /SQLite mutex/);
    const result = spawnSync(process.execPath, ["-e", `
      const {withLock} = require(process.argv[1]);
      try {withLock(process.argv[2], () => process.exit(3), {timeoutMs:0});}
      catch (error) {if (!/SQLite mutex/.test(error.message)) process.exit(4);}
    `, require.resolve("../src/team/lock"), lock], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("metadata recovery never releases a durably claimed job writer", { timeout: 10000 }, async (t) => {
  const { root } = fixture(t);
  for (const id of ["writer", "next"]) jobs.createJob(root, { id, leader: "codex", role: "backend", model: "fixture", cwd: root, writable: true, prompt: "fixture only" });
  const holder = await child(t);
  assert.deepEqual(await holder.run({ mode: "job-write", jobsPath: require.resolve("../src/team/jobs"), root }), { phase: "job-write" });
  await holder.kill();
  const before = jobs.getJob(root, "writer");
  assert.equal(before.status, "launching");
  assert.equal(before.process_stopped, false);
  assert.throws(() => jobs.claimJob(root, "next", { max_active: 2 }), /already has a writer/);
  assert.deepEqual(jobs.getJob(root, "writer"), before);
  assert.equal(jobs.getJob(root, "next").status, "queued");
  assert.throws(() => jobs.claimJob(root, "next", { max_active: 1 }), /capacity/);
});
