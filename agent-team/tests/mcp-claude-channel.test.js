const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempRoot } = require("./helpers");
const { appendMessage, listMessages, loadMessage } = require("../src/mailbox");
const paths = require("../src/paths");
const { readJsonl } = require("../src/fsutil");
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
  assert.match(init.instructions, /reply_required="true\|false"/);
  assert.match(init.instructions, /call the reply tool before finishing/i);

  const tools = toolDefinitions();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["reply", "agent_team_ack", "agent_team_reply", "agent_team_checkin", "agent_team_status", "agent_team_open_task"]
  );
  assert.equal(tools.find((tool) => tool.name === "reply").inputSchema.required[0], "text");
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
  assert.equal(notification.params.meta.chat_id, CHANNEL_ID);
  assert.equal(notification.params.meta.message_id, message.id);
  assert.equal(notification.params.meta.sender, "codex");
  assert.equal(notification.params.meta.user, "codex");
  assert.equal(notification.params.meta.mailbox_message_id, message.id);
  assert.equal(notification.params.meta.reply_required, "false");
  assert.equal(notification.params.meta.mailbox_truth, "true");
  assert.match(notification.params.meta.received_at, /^\d{4}-\d{2}-\d{2}T/);
  const text = notification.params.content;
  assert.match(text, new RegExp(message.id));
  assert.match(text, /mailbox is the source of truth/i);
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

test("Claude MCP outbox emits once per MCP consumer process", () => {
  const cwd = tempRoot();
  const message = appendMessage(cwd, {
    from: "codex",
    to: "claude",
    kind: "notify",
    subject: "Consumer race",
    body: "every consumer should see this once"
  }).message;
  queueChannelNotification(cwd, message);

  const first = deliverQueuedNotifications(cwd, () => {}, { consumer_id: "launch:pid-1" });
  const sameConsumerAgain = deliverQueuedNotifications(cwd, () => {}, { consumer_id: "launch:pid-1" });
  const secondConsumer = deliverQueuedNotifications(cwd, () => {}, { consumer_id: "launch:pid-2" });

  assert.equal(first.count, 1);
  assert.equal(sameConsumerAgain.count, 0);
  assert.equal(secondConsumer.count, 1);
  const deliveries = listDeliveredNotifications(cwd);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(
    deliveries.map((row) => row.consumer_id).sort(),
    ["launch:pid-1", "launch:pid-2"]
  );
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

test("Claude MCP reply alias writes a mailbox reply keyed by channel metadata", () => {
  const cwd = tempRoot();
  const request = appendMessage(cwd, {
    from: "codex",
    to: "claude",
    kind: "request",
    subject: "Visible steering",
    body: "ACK this.",
    request_id: "req_visible",
    reply_required: true,
    task_id: "T-000123",
    goal_id: "G-000123"
  }).message;

  const reply = parseToolResponse(
    callTool(cwd, "reply", {
      message_id: request.id,
      request_id: "req_visible",
      text: "ACK: received through first-party MCP.",
      chat_id: CHANNEL_ID
    })
  );

  assert.equal(reply.ok, true);
  assert.equal(reply.message.kind, "reply");
  assert.equal(reply.message.in_reply_to, request.id);
  assert.equal(reply.message.request_id, "req_visible");
  assert.equal(reply.message.task_id, "T-000123");
  assert.equal(reply.message.goal_id, "G-000123");
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
  assert.equal(decoded.messages[1].result.tools.length, 6);
  assert.match(decoded.messages[2].result.content[0].text, /test 123/);

  const checkins = listMessages(cwd, { from: "claude", to: "codex", kind: "checkin" });
  assert.equal(checkins.length, 1);
  assert.equal(loadMessage(cwd, checkins[0].id, { include_body: true }).body, "test 123 from Claude");
});

test("Claude MCP stdio server waits for initialized before emitting queued Agent Team channel notifications", () => {
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

  const initializeOnly = spawnSync(process.execPath, [server, "--cwd", cwd], {
    input: encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    encoding: "buffer"
  });
  assert.equal(initializeOnly.status, 0, initializeOnly.stderr.toString("utf8"));
  const initializedOnlyDecoded = decodeFrames(initializeOnly.stdout);
  assert.equal(initializedOnlyDecoded.messages.length, 1);
  assert.equal(initializedOnlyDecoded.messages[0].id, 1);
  assert.equal(listDeliveredNotifications(cwd).length, 0);

  const result = spawnSync(process.execPath, [server, "--cwd", cwd], {
    input: Buffer.concat([
      encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    ]),
    encoding: "buffer",
    env: {
      ...process.env,
      AGENT_TEAM_LAUNCH_ID: "launch_mcp_test",
      AGENT_TEAM_SESSION_NAME: "mcp-visible-test",
      AGENT_TEAM_PROJECT_DIR: cwd,
      AGENT_TEAM_HARNESS_CWD: cwd,
      AGENT_TEAM_MCP_SERVER_NAME: "agent-team-claude-launch-mcp-test"
    }
  });
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  const decoded = decodeFrames(result.stdout);
  const notification = decoded.messages.find((row) => row.method === "notifications/claude/channel");
  const initialize = decoded.messages.find((row) => row.id === 1);
  assert.ok(notification, "expected queued Claude channel notification");
  assert.ok(initialize, "expected initialize response");
  assert.equal(initialize.result.protocolVersion, "2024-11-05");
  assert.equal(initialize.result.serverInfo.name, "agent-team-claude-launch-mcp-test");
  assert.equal(notification.params.meta.mailbox_message_id, message.id);
  assert.equal(notification.params.meta.sender, "codex");
  assert.equal(notification.params.meta.reply_required, "false");
  assert.match(notification.params.content, /hello visible Claude/);
  assert.equal(listDeliveredNotifications(cwd).length, 1);
  const starts = readJsonl(paths.channelMcpStartsPath(cwd)).filter((row) => row.launch_id === "launch_mcp_test");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].event, "mcp_started");
  const inits = readJsonl(paths.channelMcpInitsPath(cwd));
  assert.equal(inits.length, 1);
  assert.equal(inits[0].launch_id, "launch_mcp_test");
  assert.equal(inits[0].event, "mcp_initialized");
});
