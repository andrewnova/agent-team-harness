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
    "Agent Team Harness is mailbox-first.",
    "The durable mailbox is the source of truth; Claude Channel notifications are live wake-up projections only.",
    "Use agent_team_ack, agent_team_reply, and agent_team_checkin to write back to Codex.",
    "Do not treat notification delivery or a tool call as a task-state transition. Codex remains proof and final-state authority."
  ].join(" ");
}

function serverName(options = {}) {
  return options.server_name || process.env.AGENT_TEAM_MCP_SERVER_NAME || SERVER_NAME;
}

function toolDefinitions() {
  return [
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
    "A durable Agent Team mailbox message is ready for you.",
    "Mailbox is the source of truth; this Claude Channel notification is only the visible wake-up copy.",
    "",
    `Mailbox message id: ${message.id}`,
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Kind: ${message.request_kind || message.kind}`,
    `Task: ${message.task_id || "(none)"}`,
    `Goal: ${message.goal_id || "(none)"}`,
    `Request id: ${message.request_id || "(none)"}`,
    `Reply required: ${message.reply_required ? "yes" : "no"}`,
    `Subject: ${message.subject || "(none)"}`,
    "",
    "Use agent_team_ack, agent_team_reply, or agent_team_checkin to respond through the mailbox.",
    "",
    "Body:",
    body || "(empty)"
  ].join("\n");
}

function channelNotification(cwd, message, options = {}) {
  return {
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: {
      content: notificationText(cwd, message),
      meta: {
        channel: String(options.channel || CHANNEL_ID),
        source: "agent-team-daemon",
        mailbox_message_id: String(message.id || ""),
        request_id: String(message.request_id || ""),
        task_id: String(message.task_id || ""),
        goal_id: String(message.goal_id || ""),
        kind: String(message.request_kind || message.kind || ""),
        mailbox_truth: "true"
      }
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

function deliveredNotificationIds(cwd) {
  return new Set(listDeliveredNotifications(cwd).map((row) => row.notification_id));
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

function markNotificationDelivered(cwd, row) {
  appendJsonl(paths.claudeMcpDeliveriesPath(cwd), {
    notification_id: row.notification_id,
    message_id: row.message_id,
    task_id: row.task_id,
    goal_id: row.goal_id,
    delivered_at: new Date().toISOString(),
    result_state: "mcp_emitted"
  });
}

function deliverQueuedNotifications(cwd, onNotification) {
  state.init(cwd);
  ensureDir(paths.claudeMcpDir(cwd));
  const delivered = deliveredNotificationIds(cwd);
  const rows = listQueuedNotifications(cwd).filter((row) => !delivered.has(row.notification_id));
  const emitted = [];
  for (const row of rows) {
    onNotification(row.notification, row);
    markNotificationDelivered(cwd, row);
    emitted.push({
      notification_id: row.notification_id,
      message_id: row.message_id,
      task_id: row.task_id,
      goal_id: row.goal_id
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
  let closed = false;
  let watcher = null;
  let timer = null;

  const pump = () => {
    if (!closed) deliverQueuedNotifications(cwd, onNotification);
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

function callTool(cwd, name, args = {}) {
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
    const result = appendMessage(cwd, {
      from: "claude",
      to: "codex",
      kind: "reply",
      subject: args.subject || "Claude reply",
      body: required(args.body, "body"),
      in_reply_to: args.in_reply_to,
      request_id: args.request_id,
      task_id: args.task_id,
      goal_id: args.goal_id,
      run_id: args.run_id
    });
    return toolResponse(compactMailboxResult(result));
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
  channelNotification,
  queueChannelNotification,
  listQueuedNotifications,
  listDeliveredNotifications,
  deliverQueuedNotifications,
  watchChannelOutbox,
  callTool
};
