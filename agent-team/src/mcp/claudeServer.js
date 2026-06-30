#!/usr/bin/env node
const path = require("node:path");
const { initializeResult, toolDefinitions, callTool } = require("./claudeChannel");

function argValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body
  ]);
}

function decodeFrames(buffer) {
  const messages = [];
  let remaining = buffer;
  while (true) {
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
  if (message.method === "initialize") return success(message.id, initializeResult());
  if (message.method === "tools/list") return success(message.id, { tools: toolDefinitions() });
  if (message.method === "tools/call") {
    const params = message.params || {};
    return success(message.id, callTool(cwd, params.name, params.arguments || {}));
  }
  if (message.method === "ping") return success(message.id, {});
  return failure(message.id, -32601, `Unknown method: ${message.method}`);
}

function runServer(options = {}) {
  const cwd = path.resolve(options.cwd || argValue(process.argv.slice(2), "--cwd", process.cwd()));
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  let buffer = Buffer.alloc(0);

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
        output.write(encodeFrame(handleRequest(cwd, message)));
      } catch (error) {
        output.write(encodeFrame(failure(message.id, -32000, error.message)));
      }
    }
  });

  return {
    close() {
      input.removeAllListeners("data");
    }
  };
}

if (require.main === module) {
  runServer();
}

module.exports = {
  encodeFrame,
  decodeFrames,
  handleRequest,
  runServer
};
