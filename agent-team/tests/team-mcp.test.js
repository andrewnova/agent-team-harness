const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { tempRoot } = require("./helpers");
const jobs = require("../src/team/jobs");
const mcp = require("../src/mcp/teamServer");
const { encodeFrame, decodeFrames } = require("../src/mcp/claudeServer");

function fixture(t, leader = "codex") {
  const root = fs.realpathSync(tempRoot());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [id, role] of [["lead", "lead"], ["worker", "review"], ["sibling", "review"]]) {
    jobs.createJob(root, { id, leader, role, model: "test-model", cwd: root, writable: id === "worker", prompt: "Test" });
    jobs.claimJob(root, id, { max_active: 8 });
  }
  return { root, context: (job_id) => mcp.createContext({ root, job_id, attempt: 1 }) };
}

for (const leader of ["codex", "claude"]) {
  test(`${leader}-led sessions have symmetric addressed send, reply and semantic report`, (t) => {
    const { root, context } = fixture(t, leader);
    const lead = context("lead");
    const worker = context("worker");
    const request = mcp.dispatchTool(lead, "team_send", { to_job: "worker", body: "Review candidate" }).message;
    assert.equal(request.from, leader);
    assert.equal(request.to, leader === "codex" ? "claude" : "codex");
    assert.equal(mcp.dispatchTool(worker, "team_inbox").messages[0].body, "Review candidate");
    assert.deepEqual(mcp.dispatchTool(context("sibling"), "team_inbox").messages, []);
    jobs.bindJob(root, "worker", 1, { workspace_id: "workspace", surface_id: "surface" });
    assert.equal(mcp.dispatchTool(worker, "team_report", { status: "ready" }).job.status, "running");
    const reply = mcp.dispatchTool(worker, "team_reply", { in_reply_to: request.id, body: "Review underway" }).message;
    assert.equal(reply.in_reply_to, request.id);
    assert.equal(reply.metadata.from_job, "worker");
    const report = mcp.dispatchTool(worker, "team_report", { status: "completed", result: "Approved with evidence", in_reply_to: request.request_id });
    assert.equal(report.job.status, "running");
    assert.equal(report.job.process_stopped, false);
    assert.equal(report.job.reported_result.result, "Approved with evidence");
    assert.equal(mcp.dispatchTool(lead, "team_inbox").messages.at(-1).body, "Approved with evidence");
    jobs.createJob(root, { id: "next", leader, role: "backend", cwd: root, writable: true, model: "test", prompt: "Next" });
    assert.throws(() => jobs.claimJob(root, "next", { max_active: 8 }), /writer/);
  });
}

test("tools have narrow schemas and reject actor, attempt, lifecycle and inbox spoofing", (t) => {
  const { context } = fixture(t);
  const lead = context("lead");
  const worker = context("worker");
  const request = mcp.dispatchTool(lead, "team_send", { to_job: "worker", body: "Read" }).message;
  const definitions = mcp.toolDefinitions();
  assert.deepEqual(definitions.map((tool) => tool.name), ["team_inbox", "team_send", "team_reply", "team_report"]);
  assert.ok(definitions.every((tool) => tool.inputSchema.additionalProperties === false));
  for (const extra of [{ from_job: "lead" }, { from: "codex" }, { from_attempt: 2 }, { cwd: "/" }, { metadata: {} }]) {
    assert.throws(() => mcp.dispatchTool(worker, "team_send", { to_job: "lead", body: "spoof", ...extra }), /unknown tool argument/);
  }
  assert.throws(() => mcp.dispatchTool(worker, "team_inbox", { job_id: "lead" }), /unknown tool argument/);
  assert.throws(() => mcp.dispatchTool(worker, "team_report", { status: "completed", result: "done", to_job: "lead", process_stopped: true }), /unknown tool argument/);
  assert.throws(() => mcp.dispatchTool(context("sibling"), "team_reply", { in_reply_to: request.id, body: "not my request" }), /not in this job/);
  assert.throws(() => mcp.dispatchTool(worker, "team_report", { status: "completed" }), /requires result/);
  assert.throws(() => mcp.dispatchTool(worker, "team_send", { to_job: "lead", body: {} }), /string/);
  assert.throws(() => mcp.dispatchTool(worker, "team_send", { to_job: "../escape", body: "x" }), /invalid/);
  assert.throws(() => mcp.dispatchTool(worker, "team_send", { to_job: "lead", body: "x", kind: "reply" }), /invalid kind/);
  assert.throws(() => mcp.dispatchTool(worker, "team_send", null), /object/);
  const failed = mcp.callTool(worker, "unknown", {});
  assert.equal(failed.isError, true);
  assert.match(JSON.parse(failed.content[0].text).error, /unknown team tool/);
});

test("launch-bound context rejects stale attempts for every tool and handshake", (t) => {
  const { root, context } = fixture(t);
  const stale = context("worker");
  assert.ok(Object.isFrozen(stale));
  jobs.finishJob(root, "worker", 1, { status: "failed", process_stopped: true });
  jobs.claimJob(root, "worker", { max_active: 8 });
  for (const name of ["team_inbox", "team_send", "team_reply", "team_report"]) assert.throws(() => mcp.dispatchTool(stale, name), /stale/);
  const handshake = mcp.handleRequest(stale, { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.match(handshake.error.message, /stale/);
  assert.throws(() => mcp.createContext({ root, job_id: "worker", attempt: 1 }), /stale/);
  assert.throws(() => mcp.createContext({ root: ".", job_id: "worker", attempt: 2 }), /absolute/);
  assert.throws(() => mcp.createContext({ root, job_id: "worker", attempt: "2" }), /invalid/);
});

test("post-send wake seam preserves durable messages across callback failure for send, reply and report", (t) => {
  const { root } = fixture(t);
  const delivered = [];
  const lead = mcp.createContext({ root, job_id: "lead", attempt: 1, onMessage(message) {
    assert.ok(jobs.jobInbox(root, "worker", 1).some((row) => row.id === message.id));
    delivered.push(message.id);
    return { status: "delivered", surface_id: "recipient-surface" };
  } });
  const sent = mcp.dispatchTool(lead, "team_send", { to_job: "worker", body: "Review" });
  assert.equal(sent.delivery.status, "delivered");
  assert.deepEqual(delivered, [sent.message.id]);
  let attempts = 0;
  const worker = mcp.createContext({ root, job_id: "worker", attempt: 1, onMessage(message) {
    assert.ok(jobs.jobInbox(root, "lead", 1).some((row) => row.id === message.id));
    attempts++;
    message.id = "callback-mutation-must-not-change-send-evidence";
    throw new Error("recipient surface unavailable");
  } });
  const reply = mcp.callTool(worker, "team_reply", { in_reply_to: sent.message.id, body: "Received" });
  assert.equal(reply.isError, undefined);
  const replyBody = JSON.parse(reply.content[0].text);
  assert.equal(replyBody.ok, true);
  assert.equal(replyBody.delivery.status, "failed");
  assert.match(replyBody.delivery.error, /surface unavailable/);
  assert.equal(replyBody.message.in_reply_to, sent.message.id);
  const report = mcp.dispatchTool(worker, "team_report", { status: "completed", result: "Reviewed", in_reply_to: sent.message.id });
  assert.equal(report.ok, true);
  assert.equal(report.job.reported_result.result, "Reviewed");
  assert.deepEqual(report.delivery, { status: "pending", reason: "waiting_for_process_stop" });
  assert.equal(report.job.reported_result.message_id, report.message.id);
  const failedSend = mcp.dispatchTool(worker, "team_send", { to_job: "lead", body: "Still sent" });
  assert.equal(failedSend.ok, true);
  assert.equal(failedSend.delivery.status, "failed");
  assert.match(failedSend.message.id, /^jobmsg_/);
  assert.equal(attempts, 2);
  assert.equal(jobs.jobInbox(root, "lead", 1).length, 3);
  assert.equal(jobs.jobInbox(root, "worker", 1).length, 1);
  const noWake = mcp.dispatchTool(mcp.createContext({ root, job_id: "worker", attempt: 1 }), "team_send", { to_job: "lead", body: "pending" });
  assert.equal(noWake.delivery.status, "pending");
});

test("terminal reports retry without duplicate messages or premature wakes and cannot overwrite the result", (t) => {
  const { root, context } = fixture(t);
  let wakes = 0;
  const worker = mcp.createContext({ root, job_id: "worker", attempt: 1, onMessage() { wakes++; return { status: "submitted" }; } });
  const input = { status: "completed", result: "Verified result", to_job: "lead" };
  const first = mcp.dispatchTool(worker, "team_report", input);
  const retry = mcp.dispatchTool(worker, "team_report", input);
  assert.equal(retry.message.id, first.message.id);
  assert.equal(wakes, 0);
  assert.equal(mcp.dispatchTool(context("lead"), "team_inbox").messages.length, 1);
  assert.equal(jobs.getJob(root, "worker").process_stopped, false);
  assert.throws(() => jobs.jobFinishedMessage(root, "worker", 1), /must have stopped/);
  assert.throws(() => mcp.dispatchTool(worker, "team_report", { ...input, result: "Changed after report" }), /different terminal result/);
  assert.throws(() => mcp.dispatchTool(worker, "team_report", { ...input, to_job: "sibling" }), /parent lead/);
  jobs.finishJob(root, "worker", 1, { status: "completed", process_stopped: true });
  const notice = jobs.jobFinishedMessage(root, "worker", 1).message;
  assert.equal(jobs.jobFinishedMessage(root, "worker", 1).message.id, notice.id);
  assert.equal(notice.metadata.event, "job_stopped");
  const inbox = mcp.dispatchTool(context("lead"), "team_inbox").messages;
  assert.equal(inbox.length, 2);
  assert.equal(JSON.parse(inbox[1].body).result_message_id, first.message.id);
});

test("standalone stdio server is self-gated and serves handshake, tools and errors without runtimes", (t) => {
  const { root } = fixture(t);
  const server = require.resolve("../src/mcp/teamServer");
  const imported = spawnSync(process.execPath, ["-e", "require(process.argv[1])", server], { encoding: "utf8", timeout: 5000 });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "team_send", arguments: { to_job: "worker", body: "hello" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "team_send", arguments: { to_job: "worker", body: "spoof", from_job: "sibling" } } },
    { jsonrpc: "2.0", id: 5, method: "unknown" }
  ];
  const run = spawnSync(process.execPath, [server, "--cwd", root, "--job", "lead", "--attempt", "1"], {
    input: Buffer.concat(input.map(encodeFrame)), encoding: "buffer", timeout: 5000,
    env: { ...process.env, PATH: path.dirname(process.execPath), AGENT_TEAM_HEADLESS: "1" }
  });
  assert.equal(run.status, 0, run.stderr.toString());
  const decoded = decodeFrames(run.stdout).messages;
  assert.equal(decoded.length, 5);
  assert.equal(decoded[0].result.protocolVersion, "2024-11-05");
  assert.equal(decoded[0].result.capabilities.tools.listChanged, false);
  assert.equal(decoded[0].result.capabilities["experimental"], undefined);
  assert.equal(decoded[1].result.tools.length, 4);
  assert.equal(JSON.parse(decoded[2].result.content[0].text).message.metadata.from_job, "lead");
  assert.equal(decoded[3].result.isError, true);
  assert.equal(decoded[4].error.code, -32601);
  assert.equal(jobs.jobInbox(root, "worker", 1)[0].body, "hello");
  const invalid = spawnSync(process.execPath, [server, "--job", "lead", "--attempt", "1"], { encoding: "utf8", timeout: 5000 });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /absolute coordinator root/);
});

test("shared frame decoder supports partial UTF-8 frames, parse errors and owned listener cleanup", (t) => {
  const { root } = fixture(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  const unrelated = () => {};
  input.on("data", unrelated);
  const server = mcp.runServer({ root, job_id: "lead", attempt: 1, input, output });
  const frame = encodeFrame({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "team_send", arguments: { to_job: "worker", body: "Hello 世界" } } });
  for (const byte of frame) input.write(Buffer.from([byte]));
  input.write("{bad}\n");
  input.write(encodeFrame({ jsonrpc: "2.0", id: 2, method: "ping" }));
  input.write(encodeFrame(null));
  input.write(encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized" }));
  const decoded = decodeFrames(Buffer.concat(chunks)).messages;
  assert.equal(JSON.parse(decoded[0].result.content[0].text).message.body_inline, "Hello 世界");
  assert.equal(decoded[1].error.code, -32700);
  assert.deepEqual(decoded[2].result, {});
  assert.equal(decoded[3].error.code, -32600);
  assert.equal(decoded.length, 4);
  server.close();
  assert.deepEqual(input.listeners("data"), [unrelated]);
  assert.equal(input.listeners("end").length, 0);
  input.destroy(); output.destroy();
});
