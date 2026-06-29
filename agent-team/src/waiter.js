const { listMessages, loadMessage, compactMessage, mailboxDiagnostics } = require("./mailbox");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchingReplies(cwd, options = {}) {
  const requestId = options.request_id;
  if (!requestId) throw new Error("await reply requires --request-id <id>");
  const replies = listMessages(cwd, {
    kind: "reply",
    from: options.from,
    to: options.to
  }).filter((message) => message.request_id === requestId || message.in_reply_to === requestId);
  return replies.map((message) => loadMessage(cwd, message.id, { include_body: true }) || message);
}

function latestActivity(cwd, options = {}) {
  return listMessages(cwd, {
    from: options.from,
    to: options.to,
    task_id: options.task_id,
    goal_id: options.goal_id,
    run_id: options.run_id
  })
    .filter((message) => message.kind === "checkin" || message.kind === "heartbeat")
    .slice(-3)
    .map(compactMessage);
}

function answeredPayload(cwd, options, reply) {
  return {
    ok: true,
    state: "answered",
    mailbox_is_truth: true,
    request_id: options.request_id,
    reply: {
      ...compactMessage(reply),
      body: reply.body || reply.body_inline || ""
    },
    latest_activity: latestActivity(cwd, options)
  };
}

async function awaitReply(cwd, options = {}) {
  const timeoutMs = Number.isFinite(options.timeout_ms) ? options.timeout_ms : 30000;
  const intervalMs = Number.isFinite(options.interval_ms) ? options.interval_ms : 500;
  const startedAt = Date.now();
  do {
    const diagnostics = mailboxDiagnostics(cwd);
    if (diagnostics.malformed_total) {
      return {
        ok: false,
        state: "blocked",
        mailbox_is_truth: true,
        request_id: options.request_id,
        diagnostics,
        error: "mailbox JSONL must be repaired before waiting for replies"
      };
    }
    const replies = matchingReplies(cwd, options);
    if (replies.length) return answeredPayload(cwd, options, replies[replies.length - 1]);
    if (options.once) break;
    if (Date.now() - startedAt >= timeoutMs) break;
    await sleep(Math.min(intervalMs, Math.max(25, timeoutMs - (Date.now() - startedAt))));
  } while (true);
  return {
    ok: false,
    state: options.once ? "waiting" : "timeout",
    mailbox_is_truth: true,
    request_id: options.request_id,
    waited_ms: Date.now() - startedAt,
    latest_activity: latestActivity(cwd, options),
    note: "No matching durable mailbox reply has landed yet; this does not mean Claude stopped working."
  };
}

module.exports = {
  awaitReply,
  matchingReplies
};
