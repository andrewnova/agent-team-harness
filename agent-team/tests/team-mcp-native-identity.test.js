const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempRoot } = require("./helpers");
const jobs = require("../src/team/jobs");
const { encodeFrame, decodeFrames } = require("../src/mcp/claudeServer");

const parentThread = "parent-thread";
const childThread = "child-thread";
const handshake = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" }
];

function fixture(t, { runtime = "codex", session_id } = {}) {
  const root = fs.realpathSync(tempRoot());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [id, role] of [["parent", "lead"], ["peer", "review"]]) {
    jobs.createJob(root, { id, leader: runtime, role, model: "test-model", cwd: root, writable: false, prompt: "Test" });
    jobs.claimJob(root, id, { max_active: 2 });
  }
  jobs.bindJob(root, "parent", 1, { workspace_id: "workspace", surface_id: "surface", ...(session_id ? { session_id } : {}) });
  return root;
}

function toolCall(id, name, args, threadId) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args,
    ...(threadId === undefined ? {} : { _meta: { threadId } }) } };
}

function runNative(root, threadId, messages) {
  const env = { ...process.env, PATH: path.dirname(process.execPath), AGENT_TEAM_HEADLESS: "1" };
  delete env.CODEX_THREAD_ID;
  if (threadId !== undefined) env.CODEX_THREAD_ID = threadId;
  const run = spawnSync(process.execPath, [require.resolve("../src/team/sessionMcp"), "--cwd", root, "--job", "parent", "--attempt", "1"], {
    env, input: Buffer.concat(messages.map(encodeFrame)), encoding: "buffer", timeout: 5000
  });
  assert.equal(run.status, 0, run.stderr.toString());
  const decoded = decodeFrames(run.stdout);
  assert.equal(decoded.remaining.length, 0);
  assert.equal(decoded.messages.length, messages.filter((message) => Object.hasOwn(message, "id")).length);
  return decoded.messages;
}

function assertDenied(response, pattern = /parent thread identity/) {
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.ok, false);
  assert.match(result.error, pattern);
}

test("native Codex parent binds once and accepts its protocol metadata", (t) => {
  const root = fixture(t);
  const responses = runNative(root, parentThread, [...handshake,
    toolCall(3, "team_report", { status: "ready" }, parentThread),
    toolCall(4, "team_send", { to_job: "peer", body: "Review this" }, parentThread)
  ]);
  assert.equal(responses[0].result.protocolVersion, "2024-11-05");
  assert.equal(responses[1].result.tools.length, 4);
  for (const response of responses.slice(2)) assert.equal(JSON.parse(response.result.content[0].text).ok, true);
  const job = jobs.getJob(root, "parent");
  assert.equal(job.session_id, parentThread);
  assert.equal(job.status, "running");
  assert.equal(job.writable, false);
  assert.equal(jobs.jobInbox(root, "peer", 1)[0].body, "Review this");
  runNative(root, parentThread, handshake);
  assert.deepEqual(jobs.getJob(root, "parent"), job);
});

test("separate native child initializes with no tools and cannot report as the parent", (t) => {
  const root = fixture(t, { session_id: parentThread });
  const before = jobs.getJob(root, "parent");
  const responses = runNative(root, childThread, [...handshake,
    toolCall(3, "team_report", { status: "completed", result: "Forged completion", to_job: "peer" }, childThread),
    toolCall(4, "team_send", { to_job: "peer", body: "Forged send" }, parentThread),
    { jsonrpc: "2.0", id: 5, method: "ping" }
  ]);
  assert.equal(responses[0].result.protocolVersion, "2024-11-05");
  assert.deepEqual(responses[0].result.capabilities.tools, { listChanged: false });
  assert.match(responses[0].result.instructions, /No harness tools/);
  assert.deepEqual(responses[1].result.tools, []);
  responses.slice(2, 4).forEach((response) => assertDenied(response));
  assert.deepEqual(responses[4].result, {});
  assert.deepEqual(jobs.getJob(root, "parent"), before);
  assert.deepEqual(jobs.jobInbox(root, "peer", 1), []);
});

test("shared parent connection rejects missing or child metadata before any mailbox or job changes", (t) => {
  const root = fixture(t, { session_id: parentThread });
  const request = jobs.sendJobMessage(root, { from_job: "peer", to_job: "parent", body: "Please review" });
  const before = jobs.getJob(root, "parent");
  const calls = [];
  for (const threadId of [undefined, childThread]) {
    for (const [name, args] of [
      ["team_inbox", {}],
      ["team_send", { to_job: "peer", body: "Forged send" }],
      ["team_reply", { in_reply_to: request.id, body: "Forged reply" }],
      ["team_report", { status: "ready" }],
      ["team_report", { status: "completed", result: "Forged result", to_job: "peer" }]
    ]) calls.push(toolCall(calls.length + 3, name, args, threadId));
  }
  const responses = runNative(root, parentThread, [...handshake, ...calls]);
  assert.equal(responses[1].result.tools.length, 4);
  responses.slice(2).forEach((response) => assertDenied(response));
  assert.deepEqual(jobs.getJob(root, "parent"), before);
  assert.deepEqual(jobs.jobInbox(root, "peer", 1), []);
  assert.equal(jobs.jobInbox(root, "parent", 1).length, 1);
});

test("model arguments cannot supply or override native caller metadata", (t) => {
  const root = fixture(t, { session_id: parentThread });
  const before = jobs.getJob(root, "parent");
  const calls = [];
  for (const extra of [{ _meta: { threadId: parentThread } }, { threadId: parentThread }, { from_job: "parent" }]) {
    for (const threadId of [undefined, childThread, parentThread]) {
      calls.push(toolCall(calls.length + 1, "team_send", { to_job: "peer", body: "Forged send", ...extra }, threadId));
    }
  }
  const responses = runNative(root, parentThread, calls);
  responses.forEach((response, index) => assertDenied(response, index % 3 === 2 ? /unknown tool argument/ : /parent thread identity/));
  assert.deepEqual(jobs.getJob(root, "parent"), before);
  assert.deepEqual(jobs.jobInbox(root, "peer", 1), []);
});

test("env-absent parent exposes tools and bootstraps only from native ready metadata", (t) => {
  const root = fixture(t);
  const before = jobs.getJob(root, "parent");
  const initial = runNative(root, undefined, handshake);
  assert.equal(initial[0].result.protocolVersion, "2024-11-05");
  assert.equal(initial[1].result.tools.length, 4);
  assert.deepEqual(jobs.getJob(root, "parent"), before);

  const responses = runNative(root, undefined, [
    toolCall(1, "team_report", { status: "ready" }, parentThread),
    toolCall(2, "team_send", { to_job: "peer", body: "Parent bootstrapped" }, parentThread)
  ]);
  for (const response of responses) assert.equal(JSON.parse(response.result.content[0].text).ok, true);
  const bound = jobs.getJob(root, "parent");
  assert.equal(bound.session_id, parentThread);
  assert.equal(bound.status, "running");
  assert.ok(bound.ready_at);
  assert.equal(bound.writable, false);
  assert.equal(jobs.jobInbox(root, "peer", 1)[0].body, "Parent bootstrapped");
  runNative(root, undefined, handshake);
  assert.deepEqual(jobs.getJob(root, "parent"), bound);
});

test("env-absent bootstrap rejects missing or invalid metadata and pre-ready mailbox work", (t) => {
  const root = fixture(t);
  const before = jobs.getJob(root, "parent");
  const calls = [undefined, null, "", "   ", 42, {}].map((threadId, index) =>
    toolCall(index + 1, "team_report", { status: "ready" }, threadId));
  calls.push(
    toolCall(7, "team_send", { to_job: "peer", body: "Too early" }, parentThread),
    toolCall(8, "team_report", { status: "completed", result: "Too early", to_job: "peer" }, parentThread),
    toolCall(9, "team_inbox", {}, parentThread),
    toolCall(10, "team_report", { status: "ready", _meta: { threadId: parentThread } }),
    toolCall(11, "team_report", { status: "ready", from_job: "parent" }, parentThread)
  );
  const responses = runNative(root, undefined, calls);
  for (const response of responses) assertDenied(response, /thread|ready|unknown tool argument/i);
  assert.deepEqual(jobs.getJob(root, "parent"), before);
  assert.deepEqual(jobs.jobInbox(root, "peer", 1), []);
});

test("env-absent child cannot rebind or use tools after parent bootstrap, including forged arguments", (t) => {
  const root = fixture(t);
  const ready = runNative(root, undefined, [toolCall(1, "team_report", { status: "ready" }, parentThread)]);
  assert.equal(JSON.parse(ready[0].result.content[0].text).ok, true);
  const bound = jobs.getJob(root, "parent");
  const responses = runNative(root, undefined, [...handshake,
    toolCall(3, "team_report", { status: "ready" }, childThread),
    toolCall(4, "team_send", { to_job: "peer", body: "Child send" }, childThread),
    toolCall(5, "team_report", { status: "completed", result: "Child completion", to_job: "peer" }, childThread),
    toolCall(6, "team_send", { to_job: "peer", body: "Forged parent", _meta: { threadId: parentThread }, threadId: parentThread }, childThread),
    toolCall(7, "team_report", { status: "ready", threadId: parentThread }, childThread),
    toolCall(8, "team_send", { to_job: "peer", body: "Missing metadata" }),
    toolCall(9, "team_inbox", {}, parentThread)
  ]);
  // Process identity is unknown: listing is permitted, authorization is per call.
  assert.equal(responses[1].result.tools.length, 4);
  responses.slice(2, -1).forEach((response) => assertDenied(response, /thread|unknown tool argument/i));
  assert.equal(JSON.parse(responses.at(-1).result.content[0].text).ok, true);
  assert.deepEqual(jobs.getJob(root, "parent"), bound);
  assert.equal(bound.session_id, parentThread);
  assert.deepEqual(jobs.jobInbox(root, "peer", 1), []);
});

test("native Claude ignores ambient Codex identity and does not require Codex request metadata", (t) => {
  const root = fixture(t, { runtime: "claude", session_id: "claude-session" });
  const responses = runNative(root, childThread, [...handshake,
    toolCall(3, "team_report", { status: "ready" }),
    toolCall(4, "team_send", { to_job: "peer", body: "Claude message" })
  ]);
  assert.equal(responses[1].result.tools.length, 4);
  for (const response of responses.slice(2)) assert.equal(JSON.parse(response.result.content[0].text).ok, true);
  assert.equal(jobs.getJob(root, "parent").session_id, "claude-session");
  assert.equal(jobs.jobInbox(root, "peer", 1)[0].body, "Claude message");
});
