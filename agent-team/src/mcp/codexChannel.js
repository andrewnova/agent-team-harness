const fs = require("node:fs");
const path = require("node:path");
const { appendMessage, ackMessage, listMessages, loadMessage, compactMessage } = require("../mailbox");
const paths = require("../paths");
const { appendJsonl, ensureDir, readJson, readJsonl, exists } = require("../fsutil");
const state = require("../state");

const MCP_SERVER_NAME = "agent-team-codex";
const CHANNEL_ID = "agent-team-codex";

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
    "Codex wake payloads are delivery projections only; mailbox.jsonl remains the source of truth.",
    "Use agent_team_codex_watch_mailbox to see Claude-to-Codex traffic, then ack or reply through the mailbox tools.",
    "Do not treat MCP reads as task completion; Codex still owns proof gates and final state."
  ].join(" ");
}

function toolDefinitions() {
  return [
    {
      name: "agent_team_codex_watch_mailbox",
      description: "Read recent Codex-bound wake payloads and unacked mailbox messages.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          include_payload: { type: "boolean" },
          task_id: { type: "string" },
          goal_id: { type: "string" }
        }
      }
    },
    {
      name: "agent_team_codex_read_mailbox",
      description: "Read one mailbox message, including body text when available.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "string" }
        },
        required: ["message_id"]
      }
    },
    {
      name: "agent_team_codex_ack",
      description: "Acknowledge that Codex has seen a Claude-to-Codex mailbox message.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          note: { type: "string" }
        },
        required: ["message_id"]
      }
    },
    {
      name: "agent_team_codex_reply",
      description: "Reply from Codex to Claude through the durable mailbox.",
      inputSchema: {
        type: "object",
        properties: {
          in_reply_to: { type: "string" },
          request_id: { type: "string" },
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
      name: "agent_team_codex_open_task",
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
      name: MCP_SERVER_NAME,
      version: options.version || packageVersion()
    },
    instructions: serverInstructions(),
    capabilities: {
      tools: {}
    }
  };
}

function safeLimit(value, fallback = 10) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, 100);
}

function loadWakePayload(cwd, row) {
  if (!row || !row.payload_path) return null;
  const file = path.resolve(cwd, row.payload_path);
  if (!file.startsWith(path.resolve(cwd))) return null;
  if (!exists(file)) return null;
  return readJson(file);
}

function wakeRows(cwd, options = {}) {
  const limit = safeLimit(options.limit);
  const rows = readJsonl(paths.codexWakeLogPath(cwd));
  const filtered = rows.filter((row) => {
    if (options.task_id && row.task_id !== options.task_id) return false;
    if (options.goal_id && row.goal_id !== options.goal_id) return false;
    return true;
  });
  return filtered.slice(-limit).map((row) => ({
    ...row,
    payload: options.include_payload ? loadWakePayload(cwd, row) : undefined
  }));
}

function receiptRows(cwd) {
  return readJsonl(paths.codexMcpReceiptsPath(cwd));
}

function watchMailbox(cwd, options = {}) {
  const limit = safeLimit(options.limit);
  const messages = listMessages(cwd, {
    to: "codex",
    task_id: options.task_id,
    goal_id: options.goal_id,
    unacked: true,
    limit
  }).map(compactMessage);
  return {
    ok: true,
    mailbox_path: path.relative(cwd, paths.mailboxPath(cwd)),
    wake_stream_path: path.relative(cwd, paths.codexWakeLogPath(cwd)),
    receipts_path: path.relative(cwd, paths.codexMcpReceiptsPath(cwd)),
    wake_rows: wakeRows(cwd, options),
    messages,
    receipts: receiptRows(cwd).slice(-limit)
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

function recordReceipt(cwd, detail) {
  ensureDir(paths.codexMcpDir(cwd));
  const record = {
    receipt_id: `codex_mcp_${detail.message_id}`,
    created_at: new Date().toISOString(),
    ...detail
  };
  appendJsonl(paths.codexMcpReceiptsPath(cwd), record);
  state.recordEvent(cwd, {
    type: "daemon.codex_mcp_message_seen",
    actor: "codex",
    task_id: detail.task_id,
    goal_id: detail.goal_id,
    detail: record
  });
  return record;
}

function callTool(cwd, name, args = {}) {
  if (name === "agent_team_codex_watch_mailbox") {
    return toolResponse(watchMailbox(cwd, args));
  }

  if (name === "agent_team_codex_read_mailbox") {
    const messageId = required(args.message_id, "message_id");
    const message = loadMessage(cwd, messageId, { include_body: true });
    if (!message) throw new Error(`Mailbox message not found: ${messageId}`);
    return toolResponse({ ok: true, message });
  }

  if (name === "agent_team_codex_ack") {
    const messageId = required(args.message_id, "message_id");
    const message = loadMessage(cwd, messageId, { include_body: true });
    if (!message) throw new Error(`Mailbox message not found: ${messageId}`);
    const ack = ackMessage(cwd, messageId, { by: "codex", note: args.note || "Seen by Codex MCP adapter." });
    const receipt = recordReceipt(cwd, {
      message_id: message.id,
      task_id: message.task_id,
      goal_id: message.goal_id,
      result_state: "seen",
      note: args.note || "Seen by Codex MCP adapter."
    });
    return toolResponse({ ok: true, ack: ack.ack, receipt });
  }

  if (name === "agent_team_codex_reply") {
    const original = args.in_reply_to ? loadMessage(cwd, args.in_reply_to, { include_body: false }) : null;
    const result = appendMessage(cwd, {
      from: "codex",
      to: original?.from || "claude",
      kind: "reply",
      subject: args.subject || "Codex reply",
      body: required(args.body, "body"),
      in_reply_to: args.in_reply_to,
      request_id: args.request_id || original?.request_id || original?.id,
      task_id: args.task_id || original?.task_id,
      goal_id: args.goal_id || original?.goal_id,
      run_id: args.run_id || original?.run_id,
      request_kind: original?.request_kind
    });
    return toolResponse(compactMailboxResult(result));
  }

  if (name === "agent_team_codex_open_task") {
    const taskId = required(args.task_id, "task_id");
    return toolResponse({
      ok: true,
      task: state.loadTask(cwd, taskId)
    });
  }

  throw new Error(`Unknown Agent Team Codex MCP tool: ${name}`);
}

module.exports = {
  MCP_SERVER_NAME,
  CHANNEL_ID,
  serverInstructions,
  toolDefinitions,
  initializeResult,
  wakeRows,
  watchMailbox,
  callTool
};
