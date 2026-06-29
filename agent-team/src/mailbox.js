const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const paths = require("./paths");
const { ensureDir, exists, writeText } = require("./fsutil");
const state = require("./state");
const db = require("./db");

const ROLES = new Set(["codex", "claude", "human"]);
const KINDS = new Set(["request", "reply", "notify", "checkin", "heartbeat", "receipt_ack"]);
const ACK_KIND = "mailbox-acks";
const MESSAGE_KIND = "mailbox-messages";
const INLINE_BODY_LIMIT = 3000;

function now() {
  return new Date().toISOString();
}

function shortId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeRole(value, flagName) {
  const role = value || null;
  if (!ROLES.has(role)) throw new Error(`${flagName} must be one of: ${Array.from(ROLES).join(", ")}`);
  return role;
}

function normalizeKind(value) {
  const kind = value || "notify";
  if (!KINDS.has(kind)) throw new Error(`--kind must be one of: ${Array.from(KINDS).join(", ")}`);
  return kind;
}

function stringifyBody(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function readBodyInput(input = {}) {
  if (input.file) return fs.readFileSync(path.resolve(input.cwd || process.cwd(), input.file), "utf8");
  return stringifyBody(input.body);
}

function bodyPathForRecord(cwd, id) {
  const absolute = paths.mailboxBodyPath(cwd, id);
  return {
    absolute,
    relative: path.relative(cwd, absolute)
  };
}

function readJsonlDetailed(file) {
  if (!fs.existsSync(file)) return { rows: [], malformed: [] };
  const rows = [];
  const malformed = [];
  fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (!line) return;
      try {
        rows.push(JSON.parse(line));
      } catch (error) {
        malformed.push({
          line: index + 1,
          raw: line,
          error: error.message
        });
      }
    });
  return { rows, malformed };
}

function readJsonlSafe(file) {
  return readJsonlDetailed(file).rows;
}

function appendJsonlDurable(file, value) {
  ensureDir(path.dirname(file));
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function findMessageRecord(cwd, messageId) {
  if (!messageId) return null;
  return readJsonlSafe(paths.mailboxPath(cwd)).find((message) => message.id === messageId) || null;
}

function appendMessage(cwd, input = {}) {
  state.init(cwd);
  const id = input.id || shortId("msg");
  const timestamp = now();
  const body = readBodyInput({ ...input, cwd });
  const kind = normalizeKind(input.kind);
  const from = normalizeRole(input.from, "--from");
  const to = normalizeRole(input.to, "--to");
  const existing = input.id ? findMessageRecord(cwd, id) : null;
  if (existing) {
    return { ok: true, message: withAckState(cwd, existing), idempotent: true };
  }
  const replyKey = input.in_reply_to || input.request_id;
  const originalRequest = kind === "reply" && replyKey ? findOriginalRequest(cwd, replyKey) : null;
  const record = {
    id,
    source: "agent-mailbox",
    from,
    to,
    kind,
    subject: input.subject || "",
    task_id: input.task_id || input.task || originalRequest?.task_id,
    goal_id: input.goal_id || input.goal || originalRequest?.goal_id,
    run_id: input.run_id || input.run || originalRequest?.run_id,
    request_id: input.request_id,
    in_reply_to: input.in_reply_to,
    reply_required: Boolean(input.reply_required),
    target: input.target,
    request_kind: input.request_kind || originalRequest?.request_kind,
    metadata: input.metadata,
    advisory_only: true,
    codex_state_authority: true,
    realtime_delivery: "mailbox-watch",
    created_at: timestamp
  };
  if (body.length > INLINE_BODY_LIMIT || input.file) {
    const bodyPath = bodyPathForRecord(cwd, id);
    writeText(bodyPath.absolute, body);
    record.body_path = bodyPath.relative;
    record.body_sha256 = crypto.createHash("sha256").update(body).digest("hex");
  } else {
    record.body_inline = body;
  }
  appendJsonlDurable(paths.mailboxPath(cwd), record);
  db.upsertAdvisory(cwd, MESSAGE_KIND, id, record, { task_id: record.task_id, goal_id: record.goal_id });
  state.recordEvent(cwd, {
    type: "mailbox.message_sent",
    actor: record.from,
    goal_id: record.goal_id,
    task_id: record.task_id,
    run_id: record.run_id,
    detail: {
      message_id: id,
      to: record.to,
      kind: record.kind,
      request_id: record.request_id,
      reply_required: record.reply_required
    }
  });
  return { ok: true, message: record };
}

function normalizeBatchMessage(cwd, batchId, defaults, message, index) {
  const errors = [];
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return {
      ok: false,
      errors: [`messages[${index}] must be an object`]
    };
  }
  const input = {
    ...defaults,
    ...message,
    metadata: {
      ...(defaults.metadata || {}),
      ...(message.metadata || {}),
      batch_id: batchId,
      batch_index: index
    }
  };
  try {
    input.from = normalizeRole(input.from, `messages[${index}].from`);
  } catch (error) {
    errors.push(error.message);
  }
  try {
    input.to = normalizeRole(input.to, `messages[${index}].to`);
  } catch (error) {
    errors.push(error.message);
  }
  try {
    input.kind = normalizeKind(input.kind);
  } catch (error) {
    errors.push(error.message.replace("--kind", `messages[${index}].kind`));
  }
  try {
    readBodyInput({ ...input, cwd });
  } catch (error) {
    errors.push(`messages[${index}] body/file could not be read: ${error.message}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    message: input
  };
}

function verifyDeliveredMessage(cwd, expected, delivered) {
  const loaded = loadMessage(cwd, delivered.id, { include_body: true });
  if (!loaded) return [`message ${delivered.id} did not land in mailbox.jsonl`];
  const errors = [];
  for (const key of ["from", "to", "kind", "task_id", "goal_id", "run_id", "request_id", "in_reply_to"]) {
    if (expected[key] === undefined || expected[key] === null) continue;
    if (expected[key] !== (loaded[key] || null)) {
      errors.push(`${delivered.id} ${key} mismatch: expected ${expected[key] || null}, got ${loaded[key] || null}`);
    }
  }
  const expectedBody = readBodyInput({ ...expected, cwd });
  if ((loaded.body || "") !== expectedBody) errors.push(`${delivered.id} body mismatch after mailbox readback`);
  return errors;
}

function appendMessagesBatch(cwd, input = {}) {
  state.init(cwd);
  const batch = Array.isArray(input) ? { messages: input } : input;
  const messages = batch.messages;
  const failures = [];
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      ok: false,
      batch_id: batch.batch_id || null,
      expected: 0,
      delivered: 0,
      failed: 1,
      messages: [],
      failures: [{ index: null, phase: "validation", errors: ["mailbox send-batch requires a non-empty messages array"] }]
    };
  }
  const batchId = batch.batch_id || shortId("batch");
  const defaults = batch.defaults || {};
  const normalized = messages.map((message, index) => normalizeBatchMessage(cwd, batchId, defaults, message, index));
  for (const [index, row] of normalized.entries()) {
    if (!row.ok) failures.push({ index, phase: "validation", errors: row.errors });
  }
  if (failures.length) {
    return {
      ok: false,
      batch_id: batchId,
      expected: messages.length,
      delivered: 0,
      failed: failures.length,
      messages: [],
      failures
    };
  }
  const delivered = [];
  for (const [index, row] of normalized.entries()) {
    try {
      const result = appendMessage(cwd, row.message);
      const readbackErrors = verifyDeliveredMessage(cwd, row.message, result.message);
      if (readbackErrors.length) {
        failures.push({ index, phase: "readback", message_id: result.message.id, errors: readbackErrors });
      } else {
        delivered.push(compactMessage({ ...result.message, batch_index: index }));
      }
    } catch (error) {
      failures.push({ index, phase: "append", errors: [error.message] });
    }
  }
  return {
    ok: failures.length === 0,
    batch_id: batchId,
    expected: messages.length,
    delivered: delivered.length,
    failed: failures.length,
    messages: delivered,
    failures
  };
}

function listAcks(cwd, filter = {}) {
  let rows = readJsonlSafe(paths.mailboxAcksPath(cwd));
  if (filter.message_id) rows = rows.filter((row) => row.message_id === filter.message_id);
  if (filter.by) rows = rows.filter((row) => row.by === filter.by);
  return rows;
}

function ackedBy(cwd, role) {
  return new Set(listAcks(cwd, { by: role }).map((row) => row.message_id));
}

function withAckState(cwd, message) {
  const acks = listAcks(cwd, { message_id: message.id });
  return {
    ...message,
    acked_by: acks.map((ack) => ack.by),
    acked: acks.length > 0
  };
}

function listMessages(cwd, filter = {}) {
  let rows = readJsonlSafe(paths.mailboxPath(cwd)).map((message) => withAckState(cwd, message));
  if (filter.to) rows = rows.filter((row) => row.to === filter.to);
  if (filter.from) rows = rows.filter((row) => row.from === filter.from);
  if (filter.kind) rows = rows.filter((row) => row.kind === filter.kind);
  if (filter.task_id) rows = rows.filter((row) => row.task_id === filter.task_id);
  if (filter.goal_id) rows = rows.filter((row) => row.goal_id === filter.goal_id);
  if (filter.run_id) rows = rows.filter((row) => row.run_id === filter.run_id);
  if (filter.in_reply_to) rows = rows.filter((row) => row.in_reply_to === filter.in_reply_to);
  if (filter.request_id) rows = rows.filter((row) => row.request_id === filter.request_id);
  if (filter.unacked) {
    const role = filter.to || filter.by;
    if (!role) throw new Error("unacked mailbox listing requires --to or --by");
    const seen = ackedBy(cwd, role);
    rows = rows.filter((row) => row.to === role && !seen.has(row.id));
  }
  if (Number.isInteger(filter.limit) && filter.limit > 0) rows = rows.slice(-filter.limit);
  return rows;
}

function findOriginalRequest(cwd, requestId) {
  if (!requestId) return null;
  return (
    readJsonlSafe(paths.mailboxPath(cwd)).find(
      (message) =>
        message.kind === "request" &&
        (message.id === requestId || message.request_id === requestId || message.in_reply_to === requestId)
    ) || null
  );
}

function loadMessage(cwd, messageId, options = {}) {
  const message = listMessages(cwd).find((row) => row.id === messageId);
  if (!message) return null;
  if (!options.include_body) return message;
  if (message.body_path) {
    const bodyFile = path.join(cwd, message.body_path);
    return {
      ...message,
      body: exists(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : ""
    };
  }
  return {
    ...message,
    body: message.body_inline || ""
  };
}

function ackMessage(cwd, messageId, input = {}) {
  state.init(cwd);
  const message = loadMessage(cwd, messageId);
  if (!message) return { ok: false, error: `mailbox message not found: ${messageId}` };
  const by = normalizeRole(input.by || message.to, "--by");
  const existing = listAcks(cwd, { message_id: messageId, by })[0];
  if (existing) return { ok: true, ack: existing, message, idempotent: true };
  const ack = {
    ack_id: input.ack_id || shortId("ack"),
    source: "agent-mailbox-ack",
    message_id: messageId,
    by,
    note: input.note || "",
    task_id: message.task_id,
    goal_id: message.goal_id,
    run_id: message.run_id,
    acknowledged_at: now()
  };
  appendJsonlDurable(paths.mailboxAcksPath(cwd), ack);
  db.upsertAdvisory(cwd, ACK_KIND, ack.ack_id, ack, { task_id: ack.task_id, goal_id: ack.goal_id });
  state.recordEvent(cwd, {
    type: "mailbox.message_acked",
    actor: by,
    goal_id: ack.goal_id,
    task_id: ack.task_id,
    run_id: ack.run_id,
    detail: {
      ack_id: ack.ack_id,
      message_id: messageId,
      note: ack.note
    }
  });
  return { ok: true, ack, message };
}

function compactMessage(message) {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    kind: message.kind,
    subject: message.subject,
    task_id: message.task_id,
    goal_id: message.goal_id,
    run_id: message.run_id,
    request_id: message.request_id,
    in_reply_to: message.in_reply_to,
    reply_required: message.reply_required,
    request_kind: message.request_kind,
    created_at: message.created_at,
    acked_by: message.acked_by || [],
    body_preview: (message.body_inline || "").slice(0, 180),
    body_path: message.body_path
  };
}

function findMailboxResponse(cwd, filter = {}) {
  const diagnostics = mailboxDiagnostics(cwd);
  if (diagnostics.mailbox_malformed.length) {
    throw new Error(`mailbox log contains malformed JSONL rows; repair before importing replies (${diagnostics.mailbox_malformed.length} malformed)`);
  }
  if (diagnostics.acks_malformed.length) {
    throw new Error(`mailbox ack log contains malformed JSONL rows; repair before importing replies (${diagnostics.acks_malformed.length} malformed)`);
  }
  const replies = listMessages(cwd, {
    to: "codex",
    from: "claude",
    kind: "reply"
  });
  const matches = replies.filter((message) => {
    const linkedRequest = findOriginalRequest(cwd, message.in_reply_to || message.request_id);
    if (filter.request_id) {
      const matchesRequest = message.in_reply_to === filter.request_id || message.request_id === filter.request_id;
      if (!matchesRequest) return false;
      if (filter.kind && linkedRequest && linkedRequest.request_kind !== filter.kind) return false;
      if (filter.kind && !linkedRequest && message.request_kind && message.request_kind !== filter.kind) return false;
      return true;
    }
    if (!linkedRequest) return false;
    if (filter.kind && linkedRequest.request_kind !== filter.kind) return false;
    if (filter.task_id && linkedRequest.task_id !== filter.task_id && message.task_id !== filter.task_id) return false;
    if (filter.goal_id && linkedRequest.goal_id !== filter.goal_id && message.goal_id !== filter.goal_id) return false;
    if (filter.run_id && linkedRequest.run_id !== filter.run_id && message.run_id !== filter.run_id) return false;
    return true;
  });
  const message = matches[matches.length - 1];
  if (!message) return null;
  const loaded = loadMessage(cwd, message.id, { include_body: true });
  return {
    request_id: loaded.in_reply_to || loaded.request_id,
    channel_request_id: loaded.channel_request_id,
    mailbox_message_id: loaded.id,
    task_id: loaded.task_id || filter.task_id,
    goal_id: loaded.goal_id || filter.goal_id,
    kind: loaded.request_kind || filter.kind,
    adapter: "mailbox",
    result_state: "answered",
    status: "answered",
    answer: loaded.body || loaded.body_inline || "",
    stdout: loaded.body || loaded.body_inline || "",
    payload: loaded.payload,
    collected_at: loaded.created_at
  };
}

function watchInbox(cwd, filter = {}, onMessages) {
  state.init(cwd);
  const intervalMs = filter.interval_ms || 1000;
  const role = normalizeRole(filter.to || "codex", "--to");
  const seen = new Set(
    filter.include_existing ? [] : listMessages(cwd, { to: role }).map((message) => message.id)
  );
  let closed = false;
  let watcher = null;
  let timer = null;

  const poll = () => {
    if (closed) return;
    const rows = listMessages(cwd, {
      to: role,
      from: filter.from,
      kind: filter.kind,
      task_id: filter.task_id,
      goal_id: filter.goal_id,
      run_id: filter.run_id,
      unacked: filter.unacked
    }).filter((message) => !seen.has(message.id));
    for (const row of rows) seen.add(row.id);
    if (rows.length) onMessages(rows);
  };

  poll();
  try {
    watcher = fs.watch(paths.commsDir(cwd), { persistent: true }, (eventType, filename) => {
      if (filename === "mailbox.jsonl" || filename === "acks.jsonl") poll();
    });
    watcher.on("error", () => {
      if (watcher) watcher.close();
      watcher = null;
    });
  } catch (_error) {
    watcher = null;
  }
  timer = setInterval(poll, intervalMs);
  return {
    close() {
      closed = true;
      if (watcher) watcher.close();
      if (timer) clearInterval(timer);
    }
  };
}

function mailboxDiagnostics(cwd) {
  const mailbox = readJsonlDetailed(paths.mailboxPath(cwd));
  const acks = readJsonlDetailed(paths.mailboxAcksPath(cwd));
  return {
    mailbox_malformed: mailbox.malformed,
    acks_malformed: acks.malformed,
    malformed_total: mailbox.malformed.length + acks.malformed.length
  };
}

module.exports = {
  appendMessage,
  appendMessagesBatch,
  listMessages,
  loadMessage,
  ackMessage,
  listAcks,
  compactMessage,
  findMailboxResponse,
  mailboxDiagnostics,
  watchInbox
};
