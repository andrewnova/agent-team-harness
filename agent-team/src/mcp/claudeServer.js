#!/usr/bin/env node
const path = require("node:path");
const { initializeResult, toolDefinitions, callTool, watchChannelOutbox } = require("./claudeChannel");
const { recordMcpInitialized, recordMcpStarted } = require("../bridge/claudeChannel/boot");

function argValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function encodeFrame(message) {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

function decodeFrames(buffer) {
  const messages = [];
  let remaining = buffer;
  while (true) {
    if (!remaining.length) break;

    const text = remaining.toString("utf8");
    if (/^Content-Length:/i.test(text)) {
      const headerEnd = remaining.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = remaining.slice(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) throw new Error("Missing Content-Length header");
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (remaining.length < bodyEnd) break;
      const body = remaining.slice(bodyStart, bodyEnd).toString("utf8");
      messages.push(JSON.parse(body));
      remaining = remaining.slice(bodyEnd);
      continue;
    }

    const lineEnd = remaining.indexOf("\n");
    if (lineEnd === -1) break;
    const line = remaining.slice(0, lineEnd).toString("utf8").trim();
    remaining = remaining.slice(lineEnd + 1);
    if (!line) continue;
    messages.push(JSON.parse(line));
  }
  return { messages, remaining };
}

function success(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function failure(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}

function handleRequest(cwd, message) {
  if (!message || message.jsonrpc !== "2.0") return failure(null, -32600, "Invalid JSON-RPC request");
  if (message.method === "initialize") {
    return success(message.id, initializeResult({ protocol_version: message.params?.protocolVersion }));
  }
  if (message.method === "tools/list") return success(message.id, { tools: toolDefinitions() });
  if (message.method === "tools/call") {
    const params = message.params || {};
    return success(message.id, callTool(cwd, params.name, params.arguments || {}));
  }
  if (message.method === "ping") return success(message.id, {});
  return failure(message.id, -32601, `Unknown method: ${message.method}`);
}

function runServer(options = {}) {
  const args = process.argv.slice(2);
  const cwd = path.resolve(options.cwd || argValue(args, "--cwd", process.cwd()));
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const watchOutbox = options.watch_outbox !== false && !args.includes("--no-watch-outbox");
  const consumerId =
    options.consumer_id ||
    process.env.AGENT_TEAM_MCP_CONSUMER_ID ||
    [process.env.AGENT_TEAM_LAUNCH_ID || "standalone", process.pid].join(":");
  let buffer = Buffer.alloc(0);
  let outboxWatcher = null;

  recordMcpStarted(cwd);

  const startOutboxWatcher = () => {
    if (!watchOutbox || outboxWatcher) return;
    outboxWatcher = watchChannelOutbox(
      cwd,
      (notification) => {
        output.write(encodeFrame(notification));
      },
      {
        include_existing: true,
        interval_ms: Number(argValue(args, "--outbox-interval-ms", "1000")) || 1000,
        consumer_id: consumerId
      }
    );
  };

  const close = () => {
    input.removeAllListeners("data");
    input.removeAllListeners("end");
    if (outboxWatcher) outboxWatcher.close();
    outboxWatcher = null;
  };

  input.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let parsed;
    try {
      parsed = decodeFrames(buffer);
    } catch (error) {
      output.write(encodeFrame(failure(null, -32700, error.message)));
      buffer = Buffer.alloc(0);
      return;
    }
    buffer = parsed.remaining;
    for (const message of parsed.messages) {
      try {
        if (message?.method === "notifications/initialized") {
          recordMcpInitialized(cwd);
          startOutboxWatcher();
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          continue;
        }
        output.write(encodeFrame(handleRequest(cwd, message)));
      } catch (error) {
        output.write(encodeFrame(failure(message.id, -32000, error.message)));
      }
    }
  });
  input.on("end", close);

  return {
    close
  };
}

if (require.main === module) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("agent-team-claude-mcp [--cwd <project-root>] [--no-watch-outbox] [--outbox-interval-ms <ms>]\n");
    process.exit(0);
  }
  runServer();
}

module.exports = {
  encodeFrame,
  decodeFrames,
  handleRequest,
  runServer
};
