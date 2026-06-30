const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempRoot } = require("./helpers");
const { appendMessage, listMessages, loadMessage } = require("../src/mailbox");
const {
  CHANNEL_ID,
  initializeResult,
  toolDefinitions,
  channelNotification,
  queueChannelNotification,
  deliverQueuedNotifications,
  listDeliveredNotifications,
  callTool
} = require("../src/mcp/claudeChannel");
const { encodeFrame, decodeFrames } = require("../src/mcp/claudeServer");

function parseToolResponse(response) {
  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, "text");
  return JSON.parse(response.content[0].text);
}

test("Claude MCP channel declares the Agent Team channel and reply tools", () => {
  const init = initializeResult({ version: "test" });
  assert.equal(init.serverInfo.name, "agent-team-claude");
  assert.deepEqual(init.capabilities.experimental["claude/channel"], {});
  assert.match(init.instructions, /mailbox is the source of truth/i);

  const tools = toolDefinitions();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["agent_team_ack", "agent_team_reply", "agent_team_checkin", "agent_team_status", "agent_team_open_task"]
  );
  assert.equal(tools.find((tool) => tool.name === "agent_team_reply").inputSchema.required[0], "body");
});

test("Claude MCP channel notification preserves mailbox identity and body", () => {
  const cwd = tempRoot();
  const message = appendMessage(cwd, {
    from: "codex",
    to: "claude",
    kind: "notify",
    subject: "Visible ping",
    body: "test 123",
    task_id: "T-000001",
    goal_id: "G-000001"
  }).message;

  const notification = channelNotification(cwd, message);
  assert.equal(notification.method, "notifications/claude/channel");
  assert.equal(notification.params.meta.channel, CHANNEL_ID);
  assert.equal(notification.params.meta.mailbox_message_id, message.id);
  assert.equal(notification.params.meta.mailbox_truth, "true");
  const text = notification.params.content;
  assert.match(text, new RegExp(message.id));
  assert.match(text, /Mailbox is the source of truth/);
  assert.match(text, /test 123/);
});

test("Claude MCP outbox queues and delivers channel notifications exactly once", () => {
  const cwd = tempRoot();
  const message = appendMessage(cwd, {
    from: "codex",
    to: "claude",
    kind: "notify",
    subject: "Outbox ping",
    body: "outbox body"
  }).message;

  const queued = queueChannelNotification(cwd, message, { daemon_run_id: "R-daemon" });
  assert.equal(queued.ok, true);
  assert.equal(queued.queued, true);
  assert.equal(queued.transport, "claude-mcp-outbox");
  assert.equal(queued.result_state, "mcp_outbox_queued");

  const duplicate = queueChannelNotification(cwd, message);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.result_state, "mcp_outbox_already_queued");

  const emitted = [];
  const first = deliverQueuedNotifications(cwd, (notification, row) => emitted.push({ notification, row }));
  assert.equal(first.count, 1);
  assert.equal(emitted[0].notification.method, "notifications/claude/channel");
  assert.equal(emitted[0].notification.params.meta.mailbox_message_id, message.id);
  assert.match(emitted[0].notification.params.content, /outbox body/);
  assert.equal(listDeliveredNotifications(cwd).length, 1);
  assert.equal(listDeliveredNotifications(cwd)[0].result_state, "mcp_emitted");

  const second = deliverQueuedNotifications(cwd, () => {
    throw new Error("should not emit already delivered notification");
  });
  assert.equal(second.count, 0);
});

test("Claude MCP tools write ACKs, replies, and check-ins through durable mailbox", () => {
  const cwd = tempRoot();
  const request = appendMessage(cwd, {
    from: "codex",
    to: "claude",
    kind: "request",
    subject: "Review",
    body: "Please review.",
    request_id: "req_review",
    reply_required: true,
    task_id: "T-000001",
    goal_id: "G-000001",
    request_kind: "review"
  }).message;

  const ack = parseToolResponse(
    callTool(cwd, "agent_team_ack", {
      message_id: request.id,
      body: "ACK: received. I will review next."
    })
  );
  assert.equal(ack.ok, true);
  assert.equal(ack.ack.message_id, request.id);
  assert.equal(ack.reply.in_reply_to, request.id);
  assert.equal(ack.reply.request_id, "req_review");

  const reply = parseToolResponse(
    callTool(cwd, "agent_team_reply", {
      in_reply_to: request.id,
      request_id: "req_review",
      subject: "Review complete",
      body: "Approved.",
      task_id: "T-000001",
      goal_id: "G-000001"
    })
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.message.kind, "reply");

  const checkin = parseToolResponse(
    callTool(cwd, "agent_team_checkin", {
      subject: "Still working",
      body: "Running one more visual pass.",
      task_id: "T-000001",
      goal_id: "G-000001"
    })
  );
  assert.equal(checkin.ok, true);
  assert.equal(checkin.message.kind, "checkin");

  const replies = listMessages(cwd, { from: "claude", to: "codex", kind: "reply" });
  assert.equal(replies.length, 2);
  assert.equal(loadMessage(cwd, replies[0].id, { include_body: true }).body, "ACK: received. I will review next.");
  assert.equal(loadMessage(cwd, replies[1].id, { include_body: true }).body, "Approved.");
});

test("Claude MCP stdio server initializes, lists tools, and writes mailbox messages", () => {
  const cwd = tempRoot();
  const server = path.join(__dirname, "..", "src", "mcp", "claudeServer.js");
  const input = Buffer.concat([
    encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    encodeFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    encodeFrame({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "agent_team_checkin",
        arguments: {
          subject: "test 123",
          body: "test 123 from Claude"
        }
      }
    })
  ]);
  const result = spawnSync(process.execPath, [server, "--cwd", cwd], {
    input,
    encoding: "buffer"
  });
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  const decoded = decodeFrames(result.stdout);
  assert.equal(decoded.messages.length, 3);
  assert.equal(decoded.messages[0].result.serverInfo.name, "agent-team-claude");
  assert.equal(decoded.messages[1].result.tools.length, 5);
  assert.match(decoded.messages[2].result.content[0].text, /test 123/);

  const checkins = listMessages(cwd, { from: "claude", to: "codex", kind: "checkin" });
  assert.equal(checkins.length, 1);
  assert.equal(loadMessage(cwd, checkins[0].id, { include_body: true }).body, "test 123 from Claude");
});

test("Claude MCP stdio server emits queued Agent Team channel notifications", () => {
  const cwd = tempRoot();
  const server = path.join(__dirname, "..", "src", "mcp", "claudeServer.js");
  const message = appendMessage(cwd, {
    from: "codex",
    to: "claude",
    kind: "notify",
    subject: "Visible server wake",
    body: "hello visible Claude"
  }).message;
  queueChannelNotification(cwd, message);

  const result = spawnSync(process.execPath, [server, "--cwd", cwd], {
    input: encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    encoding: "buffer"
  });
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  const decoded = decodeFrames(result.stdout);
  const notification = decoded.messages.find((row) => row.method === "notifications/claude/channel");
  const initialize = decoded.messages.find((row) => row.id === 1);
  assert.ok(notification, "expected queued Claude channel notification");
  assert.ok(initialize, "expected initialize response");
  assert.equal(notification.params.meta.mailbox_message_id, message.id);
  assert.match(notification.params.content, /hello visible Claude/);
  assert.equal(listDeliveredNotifications(cwd).length, 1);
});
