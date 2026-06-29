const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const paths = require("./paths");
const { ensureDir, exists, readJson, writeJson } = require("./fsutil");
const state = require("./state");
const { appendMessage, listMessages, watchInbox, compactMessage } = require("./mailbox");

const DEFAULT_ROLES = ["codex", "claude"];
const RECEIPT_ACK_KIND = "receipt_ack";
const RESPONSE_KINDS = new Set(["reply", RECEIPT_ACK_KIND]);
const ACK_EXEMPT_KINDS = new Set(["heartbeat", ...RESPONSE_KINDS]);

function normalizeRoles(value) {
  if (!value) return DEFAULT_ROLES;
  const roles = Array.isArray(value) ? value : String(value).split(",");
  const clean = roles.map((role) => role.trim()).filter(Boolean);
  return clean.length ? [...new Set(clean)] : DEFAULT_ROLES;
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function semanticAckRequired(message) {
  if (!message || ACK_EXEMPT_KINDS.has(message.kind)) return false;
  if (message.metadata && message.metadata.semantic_ack === true) return false;
  if (message.metadata && message.metadata.receipt_ack === true) return false;
  if (message.metadata && message.metadata.semantic_ack_required === true) return true;
  if (message.metadata && message.metadata.semantic_ack_required === false) return false;
  return message.kind === "request" || message.reply_required === true;
}

function receiptAckRequired(message) {
  if (!message || ACK_EXEMPT_KINDS.has(message.kind)) return false;
  if (message.metadata && message.metadata.receipt_ack === true) return false;
  return true;
}

function semanticAckInstruction(message) {
  const replyTarget = message.from || "codex";
  const requestId = message.request_id || message.id;
  return [
    `Reply through the mailbox to ${replyTarget}.`,
    `Acknowledge receipt of ${message.id}.`,
    "State what you are going to do next.",
    "Answer the question if one was asked; otherwise name the blocker or next checkpoint.",
    `Use --kind reply --request-id ${requestId} --in-reply-to ${message.id}.`
  ].join(" ");
}

function findReceiptAck(cwd, message) {
  if (!message) return null;
  return (
    listMessages(cwd, {
      from: message.to,
      to: message.from,
      kind: RECEIPT_ACK_KIND,
      in_reply_to: message.id
    })[0] || null
  );
}

function receiptAckBody(message, semantic) {
  const receiver = message.to || "receiver";
  const further = semantic
    ? "A fuller semantic reply is still expected with the next action and answer or blocker."
    : "No further semantic reply is required unless new context appears.";
  return [
    `Receipt ACK: ${receiver} inbox received ${message.id}.`,
    `Original kind: ${message.kind}.`,
    further,
    "This receipt ACK is separate from long-task check-ins and is not final completion proof."
  ].join(" ");
}

function ensureReceiptAck(cwd, runId, message, semantic) {
  if (!receiptAckRequired(message)) {
    return {
      required: false
    };
  }
  const existing = findReceiptAck(cwd, message);
  if (existing) {
    return {
      required: true,
      created: false,
      message_id: existing.id
    };
  }
  const result = appendMessage(cwd, {
    id: `receipt_${message.id}`,
    from: message.to,
    to: message.from,
    kind: RECEIPT_ACK_KIND,
    subject: `Receipt ACK: ${message.subject || message.kind || message.id}`,
    body: receiptAckBody(message, semantic),
    task_id: message.task_id,
    goal_id: message.goal_id,
    run_id: message.run_id,
    request_id: message.request_id || message.id,
    in_reply_to: message.id,
    metadata: {
      receipt_ack: true,
      generated_by: "agent-team-daemon",
      original_kind: message.kind,
      original_subject: message.subject,
      semantic_ack_required: semantic
    }
  });
  if (result.idempotent) {
    return {
      required: true,
      created: false,
      message_id: result.message.id,
      idempotent: true
    };
  }
  recordDaemonEvent(cwd, runId, "daemon.receipt_ack_sent", {
    message_id: message.id,
    receipt_ack_id: result.message.id,
    from: result.message.from,
    to: result.message.to,
    kind: message.kind,
    subject: message.subject,
    request_id: message.request_id,
    in_reply_to: message.id,
    semantic_ack_required: semantic,
    task_id: message.task_id,
    goal_id: message.goal_id
  });
  return {
    required: true,
    created: true,
    message_id: result.message.id
  };
}

function recordDaemonEvent(cwd, runId, type, detail = {}) {
  return state.recordEvent(cwd, {
    type,
    actor: "codex",
    run_id: runId,
    task_id: detail.task_id,
    goal_id: detail.goal_id,
    detail
  });
}

function handleMessages(cwd, runId, messages, options = {}) {
  const handled = [];
  for (const message of messages) {
    const semantic = semanticAckRequired(message);
    const receiptAck = ensureReceiptAck(cwd, runId, message, semantic);
    const detail = {
      message_id: message.id,
      from: message.from,
      to: message.to,
      kind: message.kind,
      subject: message.subject,
      request_id: message.request_id,
      in_reply_to: message.in_reply_to,
      reply_required: Boolean(message.reply_required),
      receipt_ack_required: receiptAck.required,
      receipt_ack_id: receiptAck.message_id,
      receipt_ack_created: receiptAck.created,
      semantic_ack_required: semantic,
      semantic_ack_instruction: semantic ? semanticAckInstruction(message) : undefined,
      task_id: message.task_id,
      goal_id: message.goal_id
    };
    recordDaemonEvent(cwd, runId, "daemon.message_received", detail);
    if (semantic) recordDaemonEvent(cwd, runId, "daemon.semantic_ack_required", detail);
    handled.push({
      ...compactMessage(message),
      receipt_ack: receiptAck,
      semantic_ack_required: semantic,
      semantic_ack_instruction: detail.semantic_ack_instruction
    });
  }
  if (options.onMessages && handled.length) options.onMessages(handled);
  return handled;
}

function daemonPidRecord(cwd) {
  if (!exists(paths.daemonPidPath(cwd))) return null;
  try {
    return readJson(paths.daemonPidPath(cwd));
  } catch (_error) {
    return null;
  }
}

function daemonStatus(cwd) {
  state.init(cwd);
  const pid_record = daemonPidRecord(cwd);
  const running = Boolean(pid_record && processAlive(pid_record.pid));
  const active_runs = state.listRuns(cwd, { kind: "daemon", status: "active" });
  return {
    ok: true,
    running,
    pid_record,
    stale_pid: Boolean(pid_record && !running),
    active_runs,
    session_push: {
      native_model_ui_push: false,
      reason: "Codex/Claude native chat panes do not expose a stable bidirectional push API to the harness.",
      mailbox_push: "receiver daemon + mailbox watch/cockpit",
      fallback_waiter: "await reply --request-id <id>"
    },
    log_path: paths.daemonLogPath(cwd),
    error_log_path: paths.daemonErrorLogPath(cwd)
  };
}

function startDaemon(cwd, options = {}) {
  state.init(cwd);
  const current = daemonStatus(cwd);
  if (current.running && !options.force) {
    return {
      ok: true,
      action: "already_running",
      ...current
    };
  }
  ensureDir(paths.daemonDir(cwd));
  const out = fs.openSync(paths.daemonLogPath(cwd), "a");
  const err = fs.openSync(paths.daemonErrorLogPath(cwd), "a");
  const entrypoint = options.entrypoint || path.join(__dirname, "cli.js");
  const args = [
    entrypoint,
    "daemon",
    "run",
    "--roles",
    normalizeRoles(options.roles).join(","),
    "--interval-ms",
    String(options.interval_ms || 1000)
  ];
  if (options.include_existing) args.push("--include-existing");
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: ["ignore", out, err],
    env: {
      ...process.env,
      AGENT_TEAM_DAEMON_CHILD: "1"
    }
  });
  fs.closeSync(out);
  fs.closeSync(err);
  child.unref();
  const pidRecord = {
    pid: child.pid,
    roles: normalizeRoles(options.roles),
    interval_ms: options.interval_ms || 1000,
    started_at: new Date().toISOString(),
    cwd,
    log_path: paths.daemonLogPath(cwd),
    error_log_path: paths.daemonErrorLogPath(cwd)
  };
  writeJson(paths.daemonPidPath(cwd), pidRecord);
  state.recordEvent(cwd, {
    type: "daemon.spawned",
    actor: "codex",
    detail: pidRecord
  });
  return {
    ok: true,
    action: "started",
    running: true,
    pid_record: pidRecord
  };
}

function stopDaemon(cwd, options = {}) {
  state.init(cwd);
  const status = daemonStatus(cwd);
  if (status.pid_record && status.running) {
    try {
      process.kill(status.pid_record.pid, options.signal || "SIGTERM");
    } catch (_error) {
      // Status below reports the remaining process state.
    }
  }
  if (exists(paths.daemonPidPath(cwd))) fs.rmSync(paths.daemonPidPath(cwd), { force: true });
  for (const run of state.listRuns(cwd, { kind: "daemon", status: "active" })) {
    state.completeRun(cwd, run.run_id, {
      status: "cancelled",
      summary: options.reason || "daemon stop requested"
    });
  }
  state.recordEvent(cwd, {
    type: "daemon.stopped",
    actor: "codex",
    detail: {
      reason: options.reason || "daemon stop requested",
      pid: status.pid_record && status.pid_record.pid
    }
  });
  return {
    ok: true,
    action: "stopped",
    previous: status,
    current: daemonStatus(cwd)
  };
}

function runDaemon(cwd, options = {}) {
  state.init(cwd);
  const roles = normalizeRoles(options.roles);
  const run = state.createRun(cwd, {
    kind: "daemon",
    title: options.title || `Mailbox receiver daemon (${roles.join(",")})`,
    owner: "codex",
    mode: "receiver",
    summary: "Hidden receiver/router for mailbox-first Codex-Claude communication.",
    metadata: {
      roles,
      interval_ms: options.interval_ms || 1000,
      receipt_ack_policy: "daemon-generated receipt_ack confirms inbox receipt and never replaces the semantic reply",
      semantic_ack_policy: "requests, reply_required messages, and explicit semantic_ack_required messages require mailbox reply with next_action and answer_or_blocker; notify/checkin without reply_required are advisory but still visible until read",
      delivery: "fs.watch plus interval fallback"
    }
  });
  writeJson(paths.daemonPidPath(cwd), {
    pid: process.pid,
    run_id: run.run_id,
    roles,
    interval_ms: options.interval_ms || 1000,
    started_at: run.started_at,
    cwd,
    foreground: true
  });
  recordDaemonEvent(cwd, run.run_id, "daemon.started", {
    roles,
    interval_ms: options.interval_ms || 1000
  });

  const emit = (payload) => {
    if (options.onOutput) options.onOutput(payload);
  };

  const scanExisting = () => {
    const rows = roles.flatMap((role) =>
      listMessages(cwd, {
        to: role,
        unacked: options.unacked !== false
      })
    );
    return handleMessages(cwd, run.run_id, rows, options);
  };

  if (options.once) {
    const handled = scanExisting();
    const completedRun = state.completeRun(cwd, run.run_id, {
      status: "complete",
      summary: `Daemon one-shot processed ${handled.length} message(s).`,
      evidence: [`daemon:${run.run_id}`]
    });
    if (exists(paths.daemonPidPath(cwd))) fs.rmSync(paths.daemonPidPath(cwd), { force: true });
    return {
      ok: true,
      run: completedRun,
      once: true,
      messages: handled
    };
  }

  const watchers = roles.map((role) =>
    watchInbox(
      cwd,
      {
        to: role,
        unacked: options.unacked !== false,
        include_existing: options.include_existing !== false,
        interval_ms: options.interval_ms || 1000
      },
      (messages) => {
        const handled = handleMessages(cwd, run.run_id, messages, options);
        emit({
          ok: true,
          run_id: run.run_id,
          role,
          messages: handled
        });
      }
    )
  );

  const close = (status = "cancelled", summary = "Daemon stopped") => {
    for (const watcher of watchers) watcher.close();
    if (exists(paths.daemonPidPath(cwd))) fs.rmSync(paths.daemonPidPath(cwd), { force: true });
    try {
      state.completeRun(cwd, run.run_id, { status, summary });
    } catch (_error) {
      // The process may already be winding down; preserve the original shutdown path.
    }
  };

  process.on("SIGINT", () => {
    close("cancelled", "Daemon interrupted");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    close("cancelled", "Daemon terminated");
    process.exit(0);
  });

  emit({
    ok: true,
    run_id: run.run_id,
    running: true,
    roles,
    semantic_ack_policy: run.metadata.semantic_ack_policy
  });
  return new Promise(() => {});
}

module.exports = {
  daemonStatus,
  startDaemon,
  stopDaemon,
  runDaemon,
  receiptAckRequired,
  findReceiptAck,
  semanticAckRequired,
  semanticAckInstruction
};
