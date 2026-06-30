#!/usr/bin/env node
const path = require("node:path");
const { encodeFrame, decodeFrames } = require("./claudeServer");
const { initializeResult, toolDefinitions, callTool } = require("./codexChannel");

function argValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
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
  let buffer = Buffer.alloc(0);

  const close = () => {
    input.removeAllListeners("data");
    input.removeAllListeners("end");
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
        if (!Object.prototype.hasOwnProperty.call(message, "id")) continue;
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
    process.stdout.write("agent-team-codex-mcp [--cwd <project-root>]\n");
    process.exit(0);
  }
  runServer();
}

module.exports = {
  handleRequest,
  runServer
};
