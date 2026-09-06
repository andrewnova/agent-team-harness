#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { encodeFrame, decodeFrames } = require("./claudeServer");
const { getJob, jobInbox, sendJobMessage, reportJob } = require("../team/jobs");

const string = { type: "string", minLength: 1 };
const jobId = { ...string, pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$" };
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

function toolDefinitions() {
  return [
    { name: "team_inbox", description: "Read durable messages addressed to this job's current attempt. No broadcast or native push.", inputSchema: schema({}) },
    { name: "team_send", description: "Send a durable addressed message as this job. The parent delivers any wake.", inputSchema: schema({ to_job: jobId, body: string, kind: { enum: ["request", "notify", "checkin"], type: "string" } }, ["to_job", "body"]) },
    { name: "team_reply", description: "Reply to an inbox message using its message or request ID. Sender and recipient attempts are checked.", inputSchema: schema({ in_reply_to: string, body: string }, ["in_reply_to", "body"]) },
    { name: "team_report", description: "Report readiness or a semantic result. Terminal reports require result and to_job or in_reply_to; they never release a still-running process or checkout.", inputSchema: schema({ status: { type: "string", enum: ["ready", "completed", "failed", "cancelled"] }, result: string, to_job: jobId, in_reply_to: string }, ["status"]) }
  ];
}

function validateArguments(definition, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool arguments must be an object");
  const spec = definition.inputSchema;
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(spec.properties, key)) throw new Error(`unknown tool argument: ${key}`);
    const rule = spec.properties[key];
    if (typeof args[key] !== "string" || !args[key].trim() || args[key].includes("\0")) throw new Error(`${key} must be a non-empty string`);
    if (rule.enum && !rule.enum.includes(args[key])) throw new Error(`invalid ${key}: ${args[key]}`);
    if (rule.pattern && !new RegExp(rule.pattern).test(args[key])) throw new Error(`invalid ${key}`);
  }
  for (const key of spec.required) {
    if (!Object.hasOwn(args, key)) throw new Error(`missing required tool argument: ${key}`);
  }
}

function assertBinding(context) {
  if (!context || !path.isAbsolute(context.root || "")) throw new Error("MCP requires an explicit absolute coordinator root");
  const job = getJob(context.root, context.job_id);
  if (!Number.isSafeInteger(context.attempt) || context.attempt < 1 || context.attempt !== job.attempt) throw new Error("MCP job attempt is stale or invalid");
  if (!["launching", "running", "cancelling"].includes(job.status)) throw new Error("MCP launch job is not active");
  return job;
}

function createContext({ root, job_id, attempt, onMessage }) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("MCP requires an explicit absolute coordinator root");
  if (onMessage !== undefined && typeof onMessage !== "function") throw new Error("onMessage must be a synchronous function");
  const context = Object.freeze({ root: fs.realpathSync(root), job_id, attempt, ...(onMessage ? { onMessage } : {}) });
  assertBinding(context);
  return context;
}

function replyTarget(context, inReplyTo) {
  const original = jobInbox(context.root, context.job_id, context.attempt)
    .find((message) => message.id === inReplyTo || message.request_id === inReplyTo);
  if (!original) throw new Error("reply target is not in this job's current inbox");
  return original.metadata.from_job;
}

// Delivery is secondary to the durable send. Never turn a wake failure into a
// failed send response that invites retrying/duplicating an already sent message.
function afterSend(context, message) {
  if (!context.onMessage) return { message, delivery: { status: "pending", reason: "wake_not_configured" } };
  try {
    const delivery = context.onMessage(structuredClone(message));
    if (delivery && typeof delivery.then === "function") {
      Promise.resolve(delivery).catch(() => {});
      throw new Error("onMessage must return synchronously");
    }
    // Validate before JSON-RPC serialization, which must also preserve the send.
    const serialized = JSON.stringify(delivery ?? { status: "pending", reason: "wake_unconfirmed" });
    return { message, delivery: JSON.parse(serialized) };
  } catch (error) {
    return { message, delivery: { status: "failed", error: error instanceof Error ? error.message : String(error) } };
  }
}

// All actor identity comes from the process launch binding, never tool input.
function dispatchTool(context, name, args = {}) {
  const boundJob = assertBinding(context);
  const definition = toolDefinitions().find((tool) => tool.name === name);
  if (!definition) throw new Error(`unknown team tool: ${name}`);
  validateArguments(definition, args);
  const send = (input) => sendJobMessage(context.root, { ...input, from_job: context.job_id, from_attempt: context.attempt });
  if (name === "team_inbox") return { ok: true, messages: jobInbox(context.root, context.job_id, context.attempt) };
  if (name === "team_send") return { ok: true, ...afterSend(context, send(args)) };
  if (name === "team_reply") {
    return { ok: true, ...afterSend(context, send({ ...args, kind: "reply", to_job: replyTarget(context, args.in_reply_to) })) };
  }
  if (args.to_job && args.in_reply_to) throw new Error("report accepts either to_job or in_reply_to, not both");
  if (args.status === "ready" && boundJob.status === "cancelling") throw new Error("cancelling job cannot report readiness");
  if (args.status !== "ready" && (!args.result || (!args.to_job && !args.in_reply_to))) throw new Error("terminal report requires result and to_job or in_reply_to");
  let message;
  if (args.to_job || args.in_reply_to) {
    message = send({
      to_job: args.to_job || replyTarget(context, args.in_reply_to),
      in_reply_to: args.in_reply_to, kind: args.in_reply_to ? "reply" : "checkin",
      body: args.result || "Ready"
    });
  }
  let job;
  try {
    job = reportJob(context.root, context.job_id, context.attempt, { status: args.status, result: args.result });
  } catch (error) {
    if (!message) throw error;
    return { ok: true, report_error: error.message, ...afterSend(context, message) };
  }
  return { ok: true, job, ...(message ? afterSend(context, message) : {}) };
}

function callTool(context, name, args = {}) {
  try {
    return { content: [{ type: "text", text: JSON.stringify(dispatchTool(context, name, args)) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: error.message }) }] };
  }
}

function failure(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

function handleRequest(context, message) {
  if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return failure(null, -32600, "Invalid JSON-RPC request");
  if (!Object.hasOwn(message, "id")) return null;
  try {
    assertBinding(context);
    let result;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: message.params?.protocolVersion || "2024-11-05",
          serverInfo: { name: "agent-team-job", version: "0.1.0" },
          capabilities: { tools: { listChanged: false } },
          instructions: "Use team_report with status ready after reading your assignment. Messages are addressed to your launch job and attempt. Semantic reports do not stop your process; only the parent releases ownership. Use team_inbox after a parent wake."
        };
        break;
      case "tools/list": result = { tools: toolDefinitions() }; break;
      case "tools/call": result = callTool(context, message.params?.name, message.params?.arguments ?? {}); break;
      case "ping": result = {}; break;
      default: return failure(message.id, -32601, `Unknown method: ${message.method}`);
    }
    return { jsonrpc: "2.0", id: message.id, result };
  } catch (error) {
    return failure(message.id, -32000, error.message);
  }
}

function runServer(options) {
  const context = createContext(options);
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let parsed;
    try { parsed = decodeFrames(buffer); } catch (error) {
      output.write(encodeFrame(failure(null, -32700, error.message)));
      buffer = Buffer.alloc(0);
      return;
    }
    buffer = parsed.remaining;
    for (const message of parsed.messages) {
      const response = handleRequest(context, message);
      if (response) output.write(encodeFrame(response));
    }
  };
  const close = () => {
    input.removeListener("data", onData);
    input.removeListener("end", onEnd);
  };
  const onEnd = () => {
    if (buffer.toString("utf8").trim()) output.write(encodeFrame(failure(null, -32700, "Incomplete JSON-RPC frame")));
    close();
  };
  input.on("data", onData);
  input.on("end", onEnd);
  return { context, close };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("teamServer.js --cwd <absolute-coordinator-root> --job <job-id> --attempt <positive-integer>\n");
  } else {
    try {
      const values = {};
      for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        if (!["--cwd", "--job", "--attempt"].includes(flag) || values[flag] !== undefined || !args[index + 1]) throw new Error(`invalid or duplicate launch argument: ${flag}`);
        values[flag] = args[index + 1];
      }
      if (!/^[1-9]\d*$/.test(values["--attempt"] || "")) throw new Error("--attempt requires a positive integer");
      runServer({ root: values["--cwd"], job_id: values["--job"], attempt: Number(values["--attempt"]) });
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = { createContext, toolDefinitions, dispatchTool, callTool, handleRequest, runServer };
