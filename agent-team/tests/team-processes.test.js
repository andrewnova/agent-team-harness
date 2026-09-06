const test = require("node:test");
const assert = require("node:assert/strict");
const { trackProcesses, inventory } = require("../src/team/processes");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jobs = require("../src/team/jobs");
const { runSession } = require("../src/team/sessionRunner");

test("native process tracking includes detached children, preserves orphan ownership and fences PID reuse", () => {
  let rows = [
    { pid: 10, parent: 1, group: 10, started: "start-one" },
    { pid: 20, parent: 10, group: 20, started: "start-two" },
    { pid: 30, parent: 20, group: 20, started: "start-three" },
    { pid: 99, parent: 1, group: 99, started: "unrelated" }
  ];
  const signals = [];
  const tracker = trackProcesses(10, { read: () => rows, signal: (...args) => signals.push(args) });
  assert.deepEqual(tracker.scan().map((row) => row.pid), [10, 20, 30]);
  rows = [
    { pid: 10, parent: 1, group: 10, started: "reused-root" },
    { pid: 20, parent: 1, group: 20, started: "start-two" },
    { pid: 31, parent: 20, group: 31, started: "new-owned-child" },
    { pid: 32, parent: 10, group: 10, started: "new-unrelated-child" }
  ];
  tracker.stop("SIGTERM");
  assert.deepEqual(signals, [[31, "SIGTERM"], [20, "SIGTERM"]]);
  rows = [];
  assert.deepEqual(tracker.scan(), []);
  assert.equal(tracker.identities().length, 4);
});

test("an unreadable process inventory cannot produce stopped evidence", () => {
  const tracker = trackProcesses(10, { read: () => { throw new Error("inventory denied"); } });
  assert.throws(() => tracker.scan(), /inventory denied/);
  assert.throws(() => tracker.stop(), /inventory denied/);
});

test("host process inventory identifies this process when the host permits observation", (t) => {
  // Restricted CI sandboxes may deny ps; absence is an explicit environment gap.
  let rows;
  try { rows = inventory(); } catch (error) { t.skip(error.message); return; }
  const own = rows.find((row) => row.pid === process.pid);
  assert.equal(own.parent, process.ppid);
  assert.ok(own.started);
});

test("native wrapper waits for a tool server that escaped its parent's process group", { timeout: 20000 }, async (t) => {
  try { inventory(); } catch (error) { t.skip(error.message); return; }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "team-process-proof-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = { CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID, CMUX_SURFACE_ID: process.env.CMUX_SURFACE_ID, PATH: process.env.PATH };
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.CMUX_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
  process.env.CMUX_SURFACE_ID = "22222222-2222-4222-8222-222222222222";
  process.env.PATH = "/usr/bin:/bin";
  jobs.createJob(root, { id: "native-proof", leader: "codex", role: "backend", model: "fixture", cwd: root, writable: true, prompt: "fixture" });
  jobs.claimJob(root, "native-proof", { max_active: 1 });
  const childFile = path.join(root, "native-fixture.js");
  const escapedPidFile = path.join(root, "escaped-pid");
  fs.writeFileSync(childFile, `#!/usr/bin/env node
const fs=require('node:fs');const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(escapedPidFile)},String(child.pid));child.unref();
setTimeout(()=>require(${JSON.stringify(require.resolve("../src/team/jobs"))}).reportJob(${JSON.stringify(root)},'native-proof',1,{status:'completed',result:'fixture complete'}),900);
setInterval(()=>{},1000);
`);
  fs.chmodSync(childFile, 0o700);
  const launch = path.join(root, "launch.json");
  fs.writeFileSync(launch, JSON.stringify({ root, job_id: "native-proof", attempt: 1, cwd: root, argv: [childFile] }));
  const receipt = await runSession(launch);
  const escaped = Number(fs.readFileSync(escapedPidFile, "utf8"));
  assert.ok(receipt.observed_processes.some((row) => row.pid === escaped));
  assert.deepEqual(receipt.remaining, []);
  assert.equal(receipt.process_stopped, true);
  assert.equal(jobs.getJob(root, "native-proof").status, "completed");
  assert.equal(inventory().some((row) => row.pid === escaped), false);
});
