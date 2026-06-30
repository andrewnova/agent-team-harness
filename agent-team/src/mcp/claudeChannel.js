const fs = require("node:fs");
const path = require("node:path");
const { appendMessage, ackMessage, listMessages, loadMessage, compactMessage } = require("../mailbox");
const paths = require("../paths");
const { appendJsonl, ensureDir } = require("../fsutil");
const state = require("../state");
const { MCP_SERVER_NAME } = require("./claudeInstall");

const CHANNEL_ID = "agent-team";
const SERVER_NAME = MCP_SERVER_NAME;

function packageVersion() {
  try {
    return require(path.join("..", "..", "package.json")).version || "0.0.0";
  } catch (_error) {
    return "0.0.0";
  }
}

function serverInstructions() {
  return [
    "Agent Team Harness is mailbox-first. The mailbox is the source of truth. The sender is Codex, not this Claude transcript.",
    "Anything Codex must see has to go through the reply, agent_team_reply, agent_team_ack, or agent_team_checkin tools; ordinary transcript text is not delivered to Codex.",
    "Messages from Codex arrive as <channel source=\"agent-team\" sender=\"codex\" chat_id=\"agent-team\" message_id=\"...\" user=\"codex\" ts=\"...\" request_id=\"...\" task_id=\"...\" goal_id=\"...\" reply_required=\"true|false\">.",
    "For reply_required=\"true\" messages, call the reply tool before finishing with text plus the message_id and request_id from the channel tag, or call agent_team_reply/agent_team_ack with the same ids.",
    "Use agent_team_checkin for progress or blockers. Do not treat notification delivery or a tool call as a task-state transition. Codex remains proof and final-state authority."
  ].join(" ");
}

function serverName(options = {}) {
  return options.server_name || process.env.AGENT_TEAM_MCP_SERVER_NAME || SERVER_NAME;
}

function toolDefinitions() {
  return [
    {
      name: "reply",
      description:
        "Reply to Codex for an inbound Agent Team channel message. Pass text plus message_id/request_id from the <channel> tag.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Reply body Codex should receive." },
          body: { type: "string", description: "Alias for text." },
          message_id: { type: "string", description: "Mailbox message id from the inbound channel tag." },
          in_reply_to: { type: "string", description: "Mailbox message id being answered." },
          request_id: { type: "string", description: "Harness request id from the inbound channel tag." },
          chat_id: { type: "string", description: "Channel chat id; pass through from the inbound tag when present." },
          subject: { type: "string" },
          task_id: { type: "string" },
          goal_id: { type: "string" },
          run_id: { type: "string" }
        },
        required: ["text"]
      }
    },
    {
      name: "agent_team_ack",
      description: "Acknowledge a mailbox message and optionally write the real reply Codex needs.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "Mailbox message id being acknowledged." },
          request_id: { type: "string", description: "Harness request id, when present." },
          note: { type: "string", description: "Short receipt note." },
          body: { type: "string", description: "Semantic ACK body." }
        },
        required: ["message_id"]
      }
    },
    {
      name: "agent_team_reply",
      description: "Send Claude's answer to Codex through the durable mailbox.",
      inputSchema: {
        type: "object",
        properties: {
          in_reply_to: { type: "string", description: "Mailbox message id or request id being answered." },
          request_id: { type: "string", description: "Harness request id." },
          subject: { type: "string" },
          body: { type: "string" },
          task_id: { type: "string" },
          goal_id: { type: "string" },
          run_id: { type: "string" }
        },
        required: ["body"]
      }
    },
    {
      name: "agent_team_checkin",
      description: "Send a progress update or blocker from Claude to Codex.",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string" },
          body: { type: "string" },
          task_id: { type: "string" },
          goal_id: { type: "string" },
          run_id: { type: "string" }
        },
        required: ["body"]
      }
    },
    {
      name: "agent_team_status",
      description: "Read recent Agent Team mailbox state visible to Claude.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          task_id: { type: "string" },
          goal_id: { type: "string" }
        }
      }
    },
    {
      name: "agent_team_open_task",
      description: "Open canonical task state by task id.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" }
        },
        required: ["task_id"]
      }
    }
  ];
}

function initializeResult(options = {}) {
  return {
    protocolVersion: options.protocol_version || "2025-06-18",
    serverInfo: {
      name: serverName(options),
      version: options.version || packageVersion()
    },
    instructions: serverInstructions(),
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {}
      }
    }
  };
}

function bodyForMessage(cwd, message) {
  if (!message) return "";
  const loaded = message.id ? loadMessage(cwd, message.id, { include_body: true }) : null;
  return loaded ? loaded.body || loaded.body_inline || "" : message.body || message.body_inline || "";
}

function notificationText(cwd, message) {
  const body = bodyForMessage(cwd, message);
  return [
    "Codex sent an Agent Team mailbox message.",
    "This channel message is the visible wake-up copy; mailbox is the source of truth.",
    "",
    `Reply required: ${message.reply_required ? "true" : "false"}`,
    `Request id: ${message.request_id || "(none)"}`,
    `Mailbox message id: ${message.id}`,
    `Task: ${message.task_id || "(none)"}`,
    `Goal: ${message.goal_id || "(none)"}`,
    `Subject: ${message.subject || "(none)"}`,
    "",
    message.reply_required
      ? `Action: call reply with message_id="${message.id}", request_id="${message.request_id || ""}", and text="ACK: received. ...".`
      : `Action: call agent_team_ack with message_id="${message.id}" if this needs a receipt, or agent_team_checkin for useful status.`,
    "",
    "Body:",
    body || "(empty)"
  ].join("\n");
}

function channelMetaForMessage(message, options = {}) {
  return {
    channel: String(options.channel || CHANNEL_ID),
    chat_id: String(options.chat_id || CHANNEL_ID),
    message_id: String(message.id || ""),
    mailbox_message_id: String(message.id || ""),
    request_id: String(message.request_id || ""),
    task_id: String(message.task_id || ""),
    goal_id: String(message.goal_id || ""),
    run_id: String(message.run_id || ""),
    kind: String(message.request_kind || message.kind || ""),
    sender: String(message.from || "codex"),
    user: String(message.from || "codex"),
    to: String(message.to || "claude"),
    subject: String(message.subject || ""),
    reply_required: message.reply_required ? "true" : "false",
    ts: new Date().toISOString(),
    received_at: new Date().toISOString(),
    source: "agent-team-daemon",
    mailbox_truth: "true"
  };
}

function channelNotification(cwd, message, options = {}) {
  return {
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: {
      content: notificationText(cwd, message),
      meta: channelMetaForMessage(message, options)
    }
  };
}

function readJsonlSafe(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function notificationIdFor(message) {
  return `claude_mcp_${message.id}`;
}

function listQueuedNotifications(cwd) {
  return readJsonlSafe(paths.claudeMcpOutboxPath(cwd));
}

function listDeliveredNotifications(cwd) {
  return readJsonlSafe(paths.claudeMcpDeliveriesPath(cwd));
}

function deliveredNotificationIds(cwd, consumerId = null) {
  return new Set(
    listDeliveredNotifications(cwd)
      .filter((row) => !consumerId || row.consumer_id === consumerId)
      .map((row) => row.notification_id)
  );
}

function queueChannelNotification(cwd, message, options = {}) {
  state.init(cwd);
  const notificationId = options.notification_id || notificationIdFor(message);
  const existing = listQueuedNotifications(cwd).find(
    (row) => row.notification_id === notificationId || row.message_id === message.id
  );
  const base = {
    ok: true,
    required: true,
    transport: "claude-mcp-outbox",
    notification_id: notificationId,
    message_id: message.id,
    task_id: message.task_id,
    goal_id: message.goal_id,
    outbox_path: path.relative(cwd, paths.claudeMcpOutboxPath(cwd))
  };
  if (existing) {
    return {
      ...base,
      queued: false,
      duplicate: true,
      result_state: "mcp_outbox_already_queued"
    };
  }

  const record = {
    notification_id: notificationId,
    created_at: new Date().toISOString(),
    source: "agent-team-daemon",
    message_id: message.id,
    request_id: message.request_id || null,
    task_id: message.task_id || null,
    goal_id: message.goal_id || null,
    run_id: message.run_id || null,
    kind: message.request_kind || message.kind,
    notification: channelNotification(cwd, message, options)
  };
  ensureDir(paths.claudeMcpDir(cwd));
  appendJsonl(paths.claudeMcpOutboxPath(cwd), record);
  state.recordEvent(cwd, {
    type: "daemon.claude_mcp_notification_queued",
    actor: "codex",
    run_id: options.daemon_run_id,
    task_id: message.task_id,
    goal_id: message.goal_id,
    detail: {
      ...base,
      queued: true,
      result_state: "mcp_outbox_queued"
    }
  });
  return {
    ...base,
    queued: true,
    result_state: "mcp_outbox_queued"
  };
}

function markNotificationDelivered(cwd, row, options = {}) {
  appendJsonl(paths.claudeMcpDeliveriesPath(cwd), {
    notification_id: row.notification_id,
    message_id: row.message_id,
    task_id: row.task_id,
    goal_id: row.goal_id,
    consumer_id: options.consumer_id || null,
    emitter_pid: process.pid,
    delivered_at: new Date().toISOString(),
    result_state: "mcp_emitted"
  });
}

function deliverQueuedNotifications(cwd, onNotification, options = {}) {
  state.init(cwd);
  ensureDir(paths.claudeMcpDir(cwd));
  const delivered = deliveredNotificationIds(cwd, options.consumer_id || null);
  const rows = listQueuedNotifications(cwd).filter((row) => !delivered.has(row.notification_id));
  const emitted = [];
  for (const row of rows) {
    onNotification(row.notification, row);
    markNotificationDelivered(cwd, row, options);
    emitted.push({
      notification_id: row.notification_id,
      message_id: row.message_id,
      task_id: row.task_id,
      goal_id: row.goal_id,
      consumer_id: options.consumer_id || null
    });
  }
  return {
    ok: true,
    emitted,
    count: emitted.length
  };
}

function watchChannelOutbox(cwd, onNotification, options = {}) {
  state.init(cwd);
  ensureDir(paths.claudeMcpDir(cwd));
  const intervalMs = options.interval_ms || 1000;
  const consumerId = options.consumer_id || null;
  let closed = false;
  let watcher = null;
  let timer = null;

  const pump = () => {
    if (!closed) deliverQueuedNotifications(cwd, onNotification, { consumer_id: consumerId });
  };

  if (options.include_existing !== false) pump();
  try {
    watcher = fs.watch(paths.claudeMcpDir(cwd), { persistent: true }, (_event, filename) => {
      if (filename === "outbox.jsonl") pump();
    });
    watcher.on("error", () => {
      if (watcher) watcher.close();
      watcher = null;
    });
  } catch (_error) {
    watcher = null;
  }
  timer = setInterval(pump, intervalMs);
  return {
    close() {
      closed = true;
      if (watcher) watcher.close();
      if (timer) clearInterval(timer);
    }
  };
}

function required(value, name) {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required`);
  return value;
}

function toolResponse(result) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}

function compactMailboxResult(result) {
  return {
    ok: result.ok,
    message: result.message ? compactMessage(result.message) : undefined,
    ack: result.ack
  };
}

function findMessageByRequestId(cwd, requestId) {
  if (!requestId) return null;
  return (
    listMessages(cwd, {
      to: "claude",
      request_id: requestId
    })[0] || null
  );
}

function originalMessageForReply(cwd, args = {}) {
  const messageId = args.message_id || args.in_reply_to;
  if (messageId) {
    const message = loadMessage(cwd, messageId, { include_body: false });
    if (message) return message;
  }
  return findMessageByRequestId(cwd, args.request_id);
}

function appendClaudeReply(cwd, args = {}) {
  const original = originalMessageForReply(cwd, args);
  const body = required(args.body || args.text, "body");
  return appendMessage(cwd, {
    from: "claude",
    to: "codex",
    kind: "reply",
    subject: args.subject || "Claude reply",
    body,
    in_reply_to: args.in_reply_to || args.message_id || original?.id,
    request_id: args.request_id || original?.request_id,
    task_id: args.task_id || original?.task_id,
    goal_id: args.goal_id || original?.goal_id,
    run_id: args.run_id || original?.run_id,
    request_kind: original?.request_kind
  });
}

function callTool(cwd, name, args = {}) {
  if (name === "reply") {
    return toolResponse(compactMailboxResult(appendClaudeReply(cwd, args)));
  }

  if (name === "agent_team_ack") {
    const messageId = required(args.message_id, "message_id");
    const message = loadMessage(cwd, messageId, { include_body: true });
    if (!message) throw new Error(`Mailbox message not found: ${messageId}`);
    const ack = ackMessage(cwd, messageId, { by: "claude", note: args.note || "Seen in Claude Code." });
    let reply = null;
    if (message.reply_required || args.body || args.request_id || message.request_id) {
      reply = appendMessage(cwd, {
        from: "claude",
        to: "codex",
        kind: "reply",
        subject: "ACK: received",
        body: args.body || "ACK: received. I will respond through the Agent Team mailbox.",
        in_reply_to: message.id,
        request_id: args.request_id || message.request_id,
        task_id: message.task_id,
        goal_id: message.goal_id,
        run_id: message.run_id,
        request_kind: message.request_kind
      });
    }
    return toolResponse({
      ok: true,
      ack: ack.ack,
      reply: reply ? compactMailboxResult(reply).message : null
    });
  }

  if (name === "agent_team_reply") {
    return toolResponse(compactMailboxResult(appendClaudeReply(cwd, args)));
  }

  if (name === "agent_team_checkin") {
    const result = appendMessage(cwd, {
      from: "claude",
      to: "codex",
      kind: "checkin",
      subject: args.subject || "Claude check-in",
      body: required(args.body, "body"),
      task_id: args.task_id,
      goal_id: args.goal_id,
      run_id: args.run_id
    });
    return toolResponse(compactMailboxResult(result));
  }

  if (name === "agent_team_status") {
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 10;
    return toolResponse({
      ok: true,
      messages: listMessages(cwd, {
        to: "claude",
        task_id: args.task_id,
        goal_id: args.goal_id,
        limit
      }).map(compactMessage)
    });
  }

  if (name === "agent_team_open_task") {
    const taskId = required(args.task_id, "task_id");
    return toolResponse({
      ok: true,
      task: state.loadTask(cwd, taskId)
    });
  }

  throw new Error(`Unknown Agent Team Claude MCP tool: ${name}`);
}

module.exports = {
  CHANNEL_ID,
  SERVER_NAME,
  serverName,
  serverInstructions,
  toolDefinitions,
  initializeResult,
  notificationText,
  channelMetaForMessage,
  channelNotification,
  queueChannelNotification,
  listQueuedNotifications,
  listDeliveredNotifications,
  deliverQueuedNotifications,
  watchChannelOutbox,
  callTool
};
