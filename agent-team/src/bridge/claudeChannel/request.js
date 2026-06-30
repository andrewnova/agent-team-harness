const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { parseJsonOutput } = require("./utils");

const LONG_FORM_REPLY_TIMEOUT_MS = 30 * 60 * 1000;
const LONG_FORM_KINDS = new Set(["plan_review", "review", "reground"]);

const PENDING_STATUSES = new Set([
  "queued",
  "pending",
  "in_progress",
  "receipt_ack",
  "mcp_outbox_queued",
  "mcp_emitted",
  "wake_sent",
  "wake_sent_reply_pending",
  "timeout_pending"
]);

function resultStateForStatus(status, exitCode, answer) {
  if (status === "answered") return answer ? "answered" : "pending";
  if (status === "needs_user") return "needs_user";
  if (status === "declined") return "declined";
  if (status === "failed") return "failed";
  if (PENDING_STATUSES.has(status)) return "pending";
  return exitCode === 0 ? "pending" : "failed";
}

function defaultReplyTimeoutMs(kind) {
  return LONG_FORM_KINDS.has(kind) ? LONG_FORM_REPLY_TIMEOUT_MS : null;
}

function replyTimeoutMsFor(request) {
  const floor = defaultReplyTimeoutMs(request.kind);
  if (!floor) return request.timeout_ms || null;
  return Math.max(request.timeout_ms || floor, floor);
}

function isReplyTimeout(stderr, error) {
  return /timed out waiting for Claude Code reply|HTTP 504|timeout/i.test(`${stderr || ""}\n${error || ""}`);
}

function sendChannelRequest(cwd, row, request, cliCommand) {
  const promptPath = path.resolve(cwd, row.prompt_path);
  const args = ["ask-file", promptPath, "--output", "json", "--sender", request.sender || "codex", "--no-progress"];
  if (request.target) args.push("--to", request.target);
  const replyTimeoutMs = replyTimeoutMsFor(request);
  if (replyTimeoutMs) args.push("--timeout-ms", String(replyTimeoutMs));
  if (request.timeout) args.push("--timeout", request.timeout);
  const result = spawnSync(cliCommand, args, {
    cwd,
    encoding: "utf8",
    timeout: request.transport_timeout_ms || undefined
  });
  const parsed = parseJsonOutput(result.stdout.trim());
  if (parsed) {
    return {
      request_id: parsed.request_id || row.request_id,
      channel_request_id: parsed.request_id,
      task_id: request.task_id,
      kind: request.kind,
      adapter: "claude-channel",
      target: parsed.target,
      status: parsed.status,
      result_state: resultStateForStatus(parsed.status, result.status, parsed.answer),
      answer: parsed.answer,
      exit_code: result.status,
      stderr: result.stderr.trim(),
      note:
        resultStateForStatus(parsed.status, result.status, parsed.answer) === "answered"
          ? undefined
          : `Claude live channel returned ${parsed.status || "no semantic status"} without a semantic answer; use mailbox-backed channel steer for real work.`
    };
  }
  const timeout = isReplyTimeout(result.stderr, result.error ? result.error.message : undefined);
  return {
    request_id: row.request_id,
    task_id: request.task_id,
    kind: request.kind,
    adapter: "claude-channel",
    result_state: timeout ? "timeout_pending" : "failed",
    exit_code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error ? result.error.message : undefined,
    timeout_ms: replyTimeoutMs || request.timeout_ms,
    note: timeout
      ? "Claude live channel timed out waiting for an immediate ask-file reply. The durable mailbox request is still authoritative; inspect mailbox replies/check-ins or use await reply --request-id."
      : undefined
  };
}

module.exports = {
  LONG_FORM_REPLY_TIMEOUT_MS,
  resultStateForStatus,
  PENDING_STATUSES,
  defaultReplyTimeoutMs,
  replyTimeoutMsFor,
  isReplyTimeout,
  sendChannelRequest
};
