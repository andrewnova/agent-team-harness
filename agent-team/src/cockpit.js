const { spawnSync } = require("node:child_process");
const path = require("node:path");
const paths = require("./paths");
const { exists, readJson, readJsonl } = require("./fsutil");
const state = require("./state");
const { loadPlanSummary } = require("./plans");
const { createBridge } = require("./bridge");
const { loadProof, evaluateProof } = require("./proof");
const { loadMerge } = require("./merge");
const { loadWorktree, listWorktrees } = require("./worktrees");
const { listMoa } = require("./moa");
const { listAgentTeamImports } = require("./agentTeams");
const { listCodexSubagentImports } = require("./codexSubagents");
const { listNotices, scanClaudeNotices } = require("./claudeNotices");
const { listCheckins } = require("./checkins");
const { listRefactorOffers } = require("./refactorLoop");
const { listSelfHealRecommendations } = require("./feedback");
const { listMessages, listAcks, compactMessage, mailboxDiagnostics } = require("./mailbox");
const { daemonStatus, receiptAckRequired, findReceiptAck, semanticAckRequired } = require("./daemon");
const { listQueuedNotifications, listDeliveredNotifications } = require("./mcp/claudeChannel");
const { statusCodexMcp } = require("./mcp/codexInstall");

const ACTIVE_STATUSES = new Set(["planning", "ready", "claimed", "implementing", "review", "merge", "verifying", "handoff", "human", "blocked"]);

function redact(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (["stdout", "token_path", "endpoints_path"].includes(childKey)) continue;
      output[childKey] = redact(childValue, childKey);
    }
    return output;
  }
  if (typeof value !== "string") return value;
  if (/token|secret|password|credential|api[_-]?key/i.test(key)) return "[redacted]";
  return value
    .replace(/(?:[A-Za-z]:)?[^\s"'{}]*\.claude-channel\/token[^\s"'{}]*/g, "[redacted-token-path]")
    .replace(/[^\s"'{}]*secret-token[^\s"'{}]*/g, "[redacted-token]");
}

function statusCounts(tasks) {
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  return counts;
}

function ownerCounts(tasks) {
  const counts = {};
  for (const task of tasks) counts[task.owner] = (counts[task.owner] || 0) + 1;
  return counts;
}

function nextActionForTask(task) {
  if (task.status === "planning") return `Finish planning evidence, then run promote-dev for ${task.goal_id}`;
  if (task.status === "ready") return `Claim ${task.task_id} as ${task.owner}`;
  if (task.status === "claimed" || task.status === "implementing") return `Record the next ${task.owner} attempt for ${task.task_id}`;
  if (task.status === "review") return `Request or import ${task.reviewer} review for ${task.task_id}`;
  if (task.status === "merge") return `Merge any task worktree, then record final tree with merge ${task.task_id}`;
  if (task.status === "verifying") return `Run proof, then done ${task.task_id}`;
  if (task.status === "handoff") return `Resume ${task.task_id} with ${task.owner} using the handoff packet`;
  if (task.status === "human") return `Human guidance needed for ${task.task_id}`;
  if (task.status === "blocked") return `Unblock ${task.task_id} before further work`;
  if (task.status === "done") return `No action for ${task.task_id}`;
  return `Inspect ${task.task_id}`;
}

function compactTask(task) {
  return {
    task_id: task.task_id,
    goal_id: task.goal_id,
    title: task.title,
    status: task.status,
    owner: task.owner,
    reviewer: task.reviewer,
    facet: task.facet,
    next_action: nextActionForTask(task)
  };
}

function compactEvent(event) {
  return {
    recorded_at: event.recorded_at,
    type: event.type,
    goal_id: event.goal_id,
    task_id: event.task_id,
    run_id: event.run_id,
    actor: event.actor,
    owner: event.owner,
    reviewer: event.reviewer,
    status: event.status
  };
}

function inferMode(goals, tasks, plans) {
  if (tasks.some((task) => task.status === "planning")) return "planning-to-dev";
  if (tasks.some((task) => ACTIVE_STATUSES.has(task.status))) return "dev";
  if (goals.some((goal) => {
    const summary = plans.find((plan) => plan.goal_id === goal.goal_id);
    return summary && !(summary.codex && summary.claude && summary.reconciled && summary.decision);
  })) {
    return "planning";
  }
  if (goals.length || tasks.length) return "complete-or-idle";
  return "choose-mode";
}

function channelSession(cwd) {
  const file = paths.channelSessionPath(cwd);
  const historyFile = paths.channelSessionsPath(cwd);
  const current = exists(file) ? readJson(file) : null;
  const history = readJsonl(historyFile);
  const latestHistory = history.length ? history[history.length - 1] : null;
  const currentTime = current && current.updated_at ? Date.parse(current.updated_at) : 0;
  const historyTime = latestHistory && latestHistory.updated_at ? Date.parse(latestHistory.updated_at) : 0;
  const useHistory = latestHistory && (!current || historyTime >= currentTime);
  const rawSession = useHistory ? latestHistory : current;
  if (!rawSession) return null;
  const session = redact(rawSession);
  return {
    ok: session.ok,
    action: session.action,
    name: session.name,
    target: session.target,
    project_dir: session.project_dir,
    harness_cwd: session.harness_cwd,
    session_identity: session.session_identity,
    launch_mode: session.launch_mode,
    session_source: useHistory ? "history_latest" : "session",
    identity_confidence: session.identity_confidence,
    reuse_source: session.reuse_source,
    remembered_endpoint: session.remembered_endpoint,
    skipped_reuse: session.skipped_reuse,
    discovered: session.discovered,
    fresh_launch_probe: session.fresh_launch_probe,
    delivery_ready: session.delivery_ready,
    visible_loaded: session.visible_loaded,
    channel_loaded: session.channel_loaded,
    reply_ready: session.reply_ready,
    updated_at: session.updated_at,
    session_path: file,
    history_path: historyFile,
    auth_help: session.auth_help,
    reason: session.reason
  };
}

function liveChannelStatus(cwd, target) {
  try {
    const adapter = createBridge("claude-channel");
    return redact(adapter.status(target, cwd));
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

function parseJsonOutput(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function claudeAgentSessions(cwd, sessionName) {
  const result = spawnSync("claude", ["agents", "--json"], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  const parsed = parseJsonOutput(result.stdout.trim());
  const rows = Array.isArray(parsed) ? parsed : [];
  const relevant = rows.filter((row) => {
    const sameCwd = row.cwd && path.resolve(row.cwd) === path.resolve(cwd);
    const sameName = sessionName && row.name === sessionName;
    return sameCwd || sameName;
  });
  return {
    ok: result.status === 0 && Array.isArray(parsed),
    checked: true,
    exit_code: result.status,
    sessions: relevant.slice(-10).map((row) => ({
      id: row.id,
      session_id: row.sessionId,
      pid: row.pid,
      name: row.name,
      cwd: row.cwd,
      kind: row.kind,
      status: row.status,
      state: row.state,
      started_at: row.startedAt
    })),
    stderr: result.stderr.trim(),
    error: result.error ? result.error.message : undefined
  };
}

function startupProbeLine(probe) {
  if (!probe) return "probe=none";
  const required = probe.require_new ? "yes" : "no";
  const selected = probe.selected_target || "none";
  return `probe=require-new:${required} new=${probe.new_project_count || 0} existing=${probe.existing_project_count || 0} checked=${probe.checked_count || 0} selected=${selected}`;
}

function rememberedEndpointLine(record) {
  if (!record) return "none";
  if (record.ok) return record.target || (record.endpoint && record.endpoint.target) || "ok";
  return record.reason || "not-used";
}

function channelStartupLine(channel) {
  if (!channel) return "none";
  const probe = channel.fresh_launch_probe || (channel.discovered && channel.discovered.probe);
  return [
    `source=${channel.session_source || "unknown"}`,
    `confidence=${channel.identity_confidence || "unknown"}`,
    `reuse=${channel.reuse_source || "n/a"}`,
    `remembered=${rememberedEndpointLine(channel.remembered_endpoint)}`,
    startupProbeLine(probe)
  ].join(" ");
}

function taskStatusMap(tasks = []) {
  return new Map(tasks.map((task) => [task.task_id, task.status]));
}

function dedupeLatest(rows, keyFn) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    byKey.set(key, row);
  }
  return Array.from(byKey.values());
}

function compactMailboxMessage(message) {
  const semantic = semanticAckRequired(message);
  const compact = compactMessage(message);
  return {
    ...compact,
    semantic_ack_required: semantic,
    informational: !semantic && message.kind !== "heartbeat" && message.kind !== "receipt_ack"
  };
}

function completedTaskId(taskId, taskStatuses) {
  return taskId && taskStatuses.get(taskId) === "done";
}

function channelQueues(cwd, tasks = []) {
  const requests = exists(paths.requestsPath(cwd)) ? readJsonl(paths.requestsPath(cwd)) : [];
  const responses = exists(paths.responsesPath(cwd)) ? readJsonl(paths.responsesPath(cwd)) : [];
  const mailboxReplies = listMessages(cwd, { kind: "reply" });
  const taskStatuses = taskStatusMap(tasks);
  const nonTerminalStates = new Set(["pending", "timeout_pending", "in_progress"]);
  const answered = new Set();
  const latestByRequest = new Map();
  for (const response of responses) {
    const responseIds = [response.request_id, response.channel_request_id].filter(Boolean);
    const terminal = !nonTerminalStates.has(response.result_state);
    for (const id of responseIds) {
      latestByRequest.set(id, response);
      if (terminal) answered.add(id);
    }
  }
  for (const message of mailboxReplies) {
    for (const id of [message.in_reply_to, message.request_id].filter(Boolean)) {
      answered.add(id);
      if (!latestByRequest.has(id)) {
        latestByRequest.set(id, {
          request_id: id,
          result_state: "answered",
          status: "answered",
          adapter: "mailbox",
          note: "answered through durable mailbox",
          mailbox_message_id: message.id,
          created_at: message.created_at
        });
      }
    }
  }
  const pendingCandidates = requests.filter((request) => request.request_id && !answered.has(request.request_id));
  const staleCompleted = pendingCandidates.filter((request) => completedTaskId(request.task_id, taskStatuses));
  const pending = pendingCandidates.filter((request) => !completedTaskId(request.task_id, taskStatuses));
  return {
    requests: requests.length,
    responses: responses.length,
    mailbox_replies: mailboxReplies.length,
    stale_completed_pending: staleCompleted.length,
    timeout_pending: pending.filter((request) => latestByRequest.get(request.request_id)?.result_state === "timeout_pending").length,
    pending: pending.slice(-5).map((request) => ({
      request_id: request.request_id,
      task_id: request.task_id,
      kind: request.kind,
      adapter: request.adapter,
      response_state: latestByRequest.get(request.request_id)?.result_state || "pending",
      response_note: latestByRequest.get(request.request_id)?.note,
      created_at: request.created_at
    }))
  };
}

function codexWakeLogPath(cwd) {
  return path.join(paths.commsDir(cwd), "codex-wake", "wake.jsonl");
}

function codexWakeState(cwd) {
  const wakeLogPath = codexWakeLogPath(cwd);
  const rows = exists(wakeLogPath) ? readJsonl(wakeLogPath) : [];
  const events = state.listEvents(cwd, { type: "daemon.codex_push_attempted", limit: 100 });
  const queuedEvents = state.listEvents(cwd, { type: "daemon.codex_push_queued", limit: 100 });
  const latestByMessage = new Map();
  for (const event of [...queuedEvents, ...events]) {
    const messageId = event.detail && event.detail.message_id;
    if (messageId) latestByMessage.set(messageId, event);
  }
  const delivered = Array.from(latestByMessage.values()).filter((event) => event.detail && event.detail.result_state === "delivered").length;
  const failed = Array.from(latestByMessage.values()).filter((event) => event.detail && event.detail.result_state === "failed").length;
  const queuedNoAdapter = Array.from(latestByMessage.values()).filter(
    (event) => event.detail && event.detail.result_state === "queued_no_adapter"
  ).length;
  const queuedPushDisabled = Array.from(latestByMessage.values()).filter(
    (event) => event.detail && event.detail.result_state === "queued_push_disabled"
  ).length;
  return {
    stream_path: path.relative(cwd, wakeLogPath),
    adapter_configured: Boolean(process.env.AGENT_TEAM_CODEX_WAKE_COMMAND),
    adapter_command: process.env.AGENT_TEAM_CODEX_WAKE_COMMAND || null,
    total: rows.length,
    delivered,
    failed,
    queued_no_adapter: queuedNoAdapter,
    queued_push_disabled: queuedPushDisabled,
    recent: rows.slice(-5).map((row) => ({
      wake_id: row.wake_id,
      message_id: row.message_id,
      from: row.from,
      to: row.to,
      kind: row.kind,
      task_id: row.task_id,
      goal_id: row.goal_id,
      subject: row.subject,
      payload_path: row.payload_path,
      created_at: row.created_at,
      result_state: latestByMessage.get(row.message_id)?.detail?.result_state || "queued"
    }))
  };
}

function claudeMcpState(cwd) {
  const queued = listQueuedNotifications(cwd);
  const emitted = listDeliveredNotifications(cwd);
  const emittedIds = new Set(emitted.map((row) => row.notification_id));
  const waiting = queued.filter((row) => !emittedIds.has(row.notification_id));
  const firstPartyEvents = state.listEvents(cwd, { type: "daemon.claude_mcp_notification_queued", limit: 100 });
  const legacyAttempts = state.listEvents(cwd, { type: "daemon.live_push_attempted", limit: 100 });
  const legacySkips = state.listEvents(cwd, { type: "daemon.live_push_skipped", limit: 100 });
  const legacyFallback = legacyAttempts.filter((event) => event.detail && event.detail.transport === "claude-channel-cli").length;
  const legacyBlocked = legacySkips.filter((event) => {
    const detail = event.detail || {};
    return detail.transport === "claude-channel-cli" && ["legacy_no_session", "legacy_cli_unavailable", "legacy_live_push_disabled", "live_push_disabled"].includes(detail.result_state);
  }).length;
  return {
    outbox_path: path.relative(cwd, paths.claudeMcpOutboxPath(cwd)),
    deliveries_path: path.relative(cwd, paths.claudeMcpDeliveriesPath(cwd)),
    queued_total: queued.length,
    waiting_for_mcp_server: waiting.length,
    mcp_emitted: emitted.length,
    first_party_events: firstPartyEvents.length,
    legacy_fallback_attempts: legacyFallback,
    legacy_blocked: legacyBlocked,
    recent: queued.slice(-5).map((row) => ({
      notification_id: row.notification_id,
      message_id: row.message_id,
      task_id: row.task_id,
      goal_id: row.goal_id,
      kind: row.kind,
      state: emittedIds.has(row.notification_id) ? "mcp_emitted" : "queued_for_mcp_server",
      created_at: row.created_at
    }))
  };
}

function pushStage(stages, type, at, detail = {}) {
  stages.push({
    type,
    at: at || detail.created_at || detail.delivered_at || detail.acknowledged_at || null,
    ...detail
  });
}

function messageTimelineState(cwd, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 8;
  const messages = listMessages(cwd);
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const acks = listAcks(cwd);
  const queuedClaude = listQueuedNotifications(cwd);
  const deliveredClaude = listDeliveredNotifications(cwd);
  const codexWakeRows = readJsonl(paths.codexWakeLogPath(cwd));
  const codexReceipts = readJsonl(paths.codexMcpReceiptsPath(cwd));
  const eventTypes = [
    "daemon.message_received",
    "daemon.semantic_ack_required",
    "daemon.receipt_ack_sent",
    "daemon.live_push_attempted",
    "daemon.live_push_skipped",
    "daemon.codex_push_attempted",
    "daemon.codex_push_queued",
    "daemon.claude_mcp_notification_queued",
    "daemon.codex_mcp_message_seen",
    "review.recorded",
    "reground.stored",
    "plan.reconciled"
  ];
  const events = eventTypes.flatMap((type) => state.listEvents(cwd, { type, limit: 200 }));
  const candidateIds = new Set(messages.slice(-50).map((message) => message.id));
  for (const row of queuedClaude) if (row.message_id) candidateIds.add(row.message_id);
  for (const row of deliveredClaude) if (row.message_id) candidateIds.add(row.message_id);
  for (const row of codexWakeRows) if (row.message_id) candidateIds.add(row.message_id);
  for (const row of codexReceipts) if (row.message_id) candidateIds.add(row.message_id);
  for (const ack of acks) if (ack.message_id) candidateIds.add(ack.message_id);
  for (const event of events) if (event.detail && event.detail.message_id) candidateIds.add(event.detail.message_id);

  const rows = Array.from(candidateIds)
    .map((messageId) => {
      const message = messageById.get(messageId);
      const requestId = message && (message.request_id || message.id);
      const taskId = message && message.task_id;
      const stages = [];
      if (message) {
        pushStage(stages, "mailbox_sent", message.created_at, {
          from: message.from,
          to: message.to,
          kind: message.kind,
          subject: message.subject
        });
      }
      for (const event of events.filter((row) => row.detail && row.detail.message_id === messageId)) {
        const detail = event.detail || {};
        const typeMap = {
          "daemon.message_received": "daemon_received",
          "daemon.semantic_ack_required": "semantic_ack_required",
          "daemon.receipt_ack_sent": "receipt_ack_sent",
          "daemon.live_push_attempted": "legacy_wake_attempted",
          "daemon.live_push_skipped": "legacy_wake_skipped",
          "daemon.codex_push_attempted": "codex_wake_attempted",
          "daemon.codex_push_queued": "codex_wake_queued",
          "daemon.claude_mcp_notification_queued": "claude_mcp_queued",
          "daemon.codex_mcp_message_seen": "codex_mcp_seen"
        };
        pushStage(stages, typeMap[event.type] || event.type, event.recorded_at, {
          result_state: detail.result_state,
          transport: detail.transport,
          run_id: event.run_id
        });
      }
      for (const row of queuedClaude.filter((item) => item.message_id === messageId)) {
        pushStage(stages, "claude_mcp_queued", row.created_at, {
          notification_id: row.notification_id
        });
      }
      for (const row of deliveredClaude.filter((item) => item.message_id === messageId)) {
        pushStage(stages, "claude_mcp_emitted", row.delivered_at, {
          notification_id: row.notification_id,
          result_state: row.result_state
        });
      }
      for (const row of codexWakeRows.filter((item) => item.message_id === messageId)) {
        pushStage(stages, "codex_wake_payload", row.created_at, {
          wake_id: row.wake_id,
          payload_path: row.payload_path
        });
      }
      for (const row of codexReceipts.filter((item) => item.message_id === messageId)) {
        pushStage(stages, "codex_mcp_seen", row.created_at, {
          receipt_id: row.receipt_id,
          result_state: row.result_state
        });
      }
      for (const ack of acks.filter((item) => item.message_id === messageId)) {
        pushStage(stages, "mailbox_ack", ack.acknowledged_at, {
          by: ack.by,
          ack_id: ack.ack_id,
          note: ack.note
        });
      }
      const replies = messages.filter(
        (reply) =>
          reply.kind === "reply" &&
          (reply.in_reply_to === messageId ||
            (requestId && reply.request_id === requestId) ||
            (message && message.request_id && reply.in_reply_to === message.request_id))
      );
      for (const reply of replies) {
        pushStage(stages, "mailbox_reply", reply.created_at, {
          message_id: reply.id,
          from: reply.from,
          to: reply.to,
          subject: reply.subject
        });
      }
      for (const event of events.filter((row) => row.task_id && row.task_id === taskId && ["review.recorded", "reground.stored", "plan.reconciled"].includes(row.type))) {
        pushStage(stages, event.type.replace(/\./g, "_"), event.recorded_at, {
          task_id: event.task_id,
          goal_id: event.goal_id
        });
      }
      const sortedStages = stages.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
      const terminal = [...sortedStages].reverse().find((stage) =>
        ["mailbox_reply", "review_recorded", "reground_stored", "plan_reconciled", "mailbox_ack", "codex_mcp_seen", "claude_mcp_emitted"].includes(stage.type)
      );
      return {
        message_id: messageId,
        from: message?.from || null,
        to: message?.to || null,
        kind: message?.kind || null,
        task_id: message?.task_id || null,
        goal_id: message?.goal_id || null,
        subject: message?.subject || null,
        current_state: terminal ? terminal.type : sortedStages.length ? sortedStages[sortedStages.length - 1].type : "unknown",
        last_at: sortedStages.length ? sortedStages[sortedStages.length - 1].at : null,
        stages: sortedStages
      };
    })
    .filter((row) => row.stages.length)
    .sort((a, b) => String(b.last_at || "").localeCompare(String(a.last_at || "")))
    .slice(0, limit);
  return {
    total_candidates: candidateIds.size,
    shown: rows.length,
    rows
  };
}

function mailboxState(cwd, tasks = []) {
  const diagnostics = mailboxDiagnostics(cwd);
  const messages = listMessages(cwd);
  const taskStatuses = taskStatusMap(tasks);
  const codexUnreadCandidates = listMessages(cwd, { to: "codex", unacked: true });
  const claudeUnreadCandidates = listMessages(cwd, { to: "claude", unacked: true });
  const staleCompletedUnread =
    codexUnreadCandidates.filter((message) => completedTaskId(message.task_id, taskStatuses)).length +
    claudeUnreadCandidates.filter((message) => completedTaskId(message.task_id, taskStatuses)).length;
  const codexUnread = codexUnreadCandidates.filter((message) => !completedTaskId(message.task_id, taskStatuses)).slice(-8);
  const claudeUnread = claudeUnreadCandidates.filter((message) => !completedTaskId(message.task_id, taskStatuses)).slice(-8);
  const replyKeys = new Set(
    messages
      .filter((message) => message.kind === "reply" && message.from === "claude")
      .flatMap((message) => [message.in_reply_to, message.request_id].filter(Boolean))
  );
  const pendingReplyCandidates = messages
    .filter((message) => message.to === "claude" && message.kind === "request" && message.reply_required)
    .filter((message) => !replyKeys.has(message.id) && !replyKeys.has(message.request_id));
  const staleCompletedReplies = pendingReplyCandidates.filter((message) => completedTaskId(message.task_id, taskStatuses));
  const pendingReplyRequired = pendingReplyCandidates
    .filter((message) => !completedTaskId(message.task_id, taskStatuses))
    .slice(-8);
  const pendingReceiptCandidates = messages
    .filter((message) => receiptAckRequired(message))
    .filter((message) => !findReceiptAck(cwd, message));
  const staleCompletedReceiptAcks = pendingReceiptCandidates.filter((message) => completedTaskId(message.task_id, taskStatuses));
  const pendingReceiptAck = pendingReceiptCandidates
    .filter((message) => !completedTaskId(message.task_id, taskStatuses))
    .slice(-8);
  const receiptAckRows = messages.filter((message) => message.kind === "receipt_ack");
  const dedupedReceiptAcks = dedupeLatest(receiptAckRows, (message) => message.in_reply_to || message.id);
  const recentReceiptAcks = dedupedReceiptAcks.slice(-8);
  const recentClaudeCheckins = messages
    .filter((message) => message.from === "claude" && (message.kind === "checkin" || message.kind === "heartbeat"))
    .slice(-5);
  return {
    total: messages.length,
    codex_unread: codexUnread.length,
    claude_unread: claudeUnread.length,
    pending_receipt_ack: pendingReceiptAck.length,
    pending_reply_required: pendingReplyRequired.length,
    stale_completed_unread: staleCompletedUnread,
    stale_completed_receipt_ack: staleCompletedReceiptAcks.length,
    stale_completed_reply_required: staleCompletedReplies.length,
    duplicate_receipt_acks_collapsed: receiptAckRows.length - dedupedReceiptAcks.length,
    diagnostics,
    codex_inbox: codexUnread.map(compactMailboxMessage),
    claude_inbox: claudeUnread.map(compactMailboxMessage),
    pending_receipt_acks: pendingReceiptAck.map(compactMailboxMessage),
    recent_receipt_acks: recentReceiptAcks.map(compactMailboxMessage),
    pending_replies: pendingReplyRequired.map(compactMailboxMessage),
    recent_claude_checkins: recentClaudeCheckins.map(compactMailboxMessage)
  };
}

function planningSummaries(cwd, goals) {
  return goals.map((goal) => {
    const summary = loadPlanSummary(cwd, goal.goal_id);
    return {
      goal_id: goal.goal_id,
      title: goal.title,
      codex: summary.codex,
      claude: summary.claude,
      reconciled: summary.reconciled,
      decision: Boolean(summary.decision)
    };
  });
}

function proofBlockers(cwd, tasks) {
  const blockers = [];
  for (const task of tasks) {
    if (task.status === "merge" && !loadMerge(cwd, task.task_id)) {
      const worktree = loadWorktree(cwd, task.task_id);
      if (worktree && worktree.status !== "merged") {
        blockers.push({
          task_id: task.task_id,
          status: task.status,
          blocker: `worktree is ${worktree.status}, not merged`,
          next_command: `worktree merge ${task.task_id}`
        });
      }
      blockers.push({
        task_id: task.task_id,
        status: task.status,
        blocker: "merge record is missing",
        next_command: `merge ${task.task_id}`
      });
    }
    if (task.status === "verifying") {
      const manifest = loadProof(cwd, task.task_id);
      if (!manifest) {
        blockers.push({
          task_id: task.task_id,
          status: task.status,
          blocker: "proof manifest is missing",
          next_command: `verify run ${task.task_id}`
        });
      } else {
        const result = evaluateProof(cwd, task, manifest);
        for (const error of result.errors) {
          blockers.push({
            task_id: task.task_id,
            status: task.status,
            blocker: error,
            next_command: `fix proof for ${task.task_id}`
          });
        }
      }
    }
  }
  return blockers;
}

function topNextActions(mode, goals, activeTasks, plans, claude, blockers = [], notices = [], checkins = [], selfHeal = [], refactorOffers = [], mailbox = null, daemon = null) {
  const actions = [];
  if (daemon && !daemon.running) {
    actions.push("Start the receiver daemon for fast mailbox routing: daemon start --roles codex,claude --include-existing");
  }
  if (daemon?.codex_wake?.queued_no_adapter) {
    actions.push(`Configure AGENT_TEAM_CODEX_WAKE_COMMAND or inspect ${daemon.codex_wake.stream_path}; ${daemon.codex_wake.queued_no_adapter} Codex wake payload(s) are queued without a local adapter`);
  }
  if (daemon?.codex_wake?.failed) {
    actions.push(`Inspect failed Codex wake adapter delivery in ${daemon.codex_wake.stream_path}`);
  }
  if (mailbox?.diagnostics?.malformed_total) {
    actions.push(`Repair mailbox JSONL corruption before importing replies: ${mailbox.diagnostics.malformed_total} malformed row(s)`);
  }
  for (const message of (mailbox?.pending_receipt_acks || []).slice(0, 2)) {
    actions.push(`Generate receipt ACK for ${message.id}${message.task_id ? ` ${message.task_id}` : ""}: ${message.subject || message.body_preview || message.kind}`);
  }
  for (const message of (mailbox?.codex_inbox || []).slice(0, 3)) {
    const semantic = message.semantic_ack_required ? " and send semantic ACK/reply" : "";
    const label =
      message.kind === "receipt_ack"
        ? "Read Codex receipt ACK"
        : message.semantic_ack_required
          ? "Read Codex mailbox"
          : "Read Codex advisory mailbox";
    actions.push(`${label} ${message.id}${message.task_id ? ` for ${message.task_id}` : ""}${semantic}: ${message.subject || message.body_preview || message.kind}`);
  }
  for (const message of (mailbox?.pending_replies || []).slice(0, 2)) {
    actions.push(`Claude semantic ACK/reply pending for ${message.id}${message.task_id ? ` ${message.task_id}` : ""}: ${message.subject || message.request_kind || message.kind}`);
  }
  for (const notice of notices.slice(0, 3)) {
    actions.push(`Read Claude notice ${notice.notice_id}: ${notice.title}`);
  }
  for (const checkin of checkins.slice(0, 3)) {
    actions.push(`Read Claude check-in ${checkin.checkin_id}${checkin.task_id ? ` for ${checkin.task_id}` : ""}: ${checkin.steer || checkin.summary}`);
  }
  for (const recommendation of selfHeal.slice(0, 2)) {
    const prefix = recommendation.type === "tool_change_request" || recommendation.change_request ? "Review tool change request" : "Review self-heal recommendation";
    const source = recommendation.source ? ` from ${recommendation.source}` : "";
    actions.push(`${prefix}${source} ${recommendation.recommendation_id}: ${recommendation.title}`);
  }
  for (const offer of refactorOffers.slice(0, 2)) {
    actions.push(`Decide whether to start refactor offer ${offer.offer_id}: ${offer.title}`);
  }
  const agentSessions = claude.agents && Array.isArray(claude.agents.sessions) ? claude.agents.sessions : [];
  const blockedClaude = agentSessions.find((session) => session.state === "blocked" || session.status === "blocked");
  if (blockedClaude) {
    actions.push(`Unblock visible Claude Code teammate ${blockedClaude.name || blockedClaude.id || "session"} before expecting channel replies`);
  }
  if (mode === "choose-mode") {
    actions.push("Choose Planning Mode for a new project, or Dev Mode if task JSON already exists");
    actions.push("Create a goal with goal new --title <title> --objective <objective>");
  }
  for (const plan of plans) {
    if (!plan.codex) actions.push(`Record Codex plan for ${plan.goal_id}`);
    if (!plan.claude) actions.push(`Ask/import Claude plan critique for ${plan.goal_id}`);
    if (plan.codex && plan.claude && !plan.reconciled) actions.push(`Reconcile Codex and Claude plans for ${plan.goal_id}`);
  }
  for (const blocker of blockers.slice(0, 3)) actions.push(`${blocker.task_id}: ${blocker.blocker}`);
  for (const task of activeTasks.slice(0, 6)) actions.push(task.next_action);
  if (!goals.length && !activeTasks.length && claude.session && claude.session.ok === false) {
    actions.push("Fix Claude channel startup before live teammate requests");
  }
  if (claude.session && claude.session.action === "fresh_start_no_new_endpoint") {
    const probe = claude.session.fresh_launch_probe || (claude.session.discovered && claude.session.discovered.probe);
    const existing = probe ? probe.existing_project_count || 0 : 0;
    const fresh = probe ? probe.new_project_count || 0 : 0;
    actions.push(`Fresh Claude launch did not register a new same-project endpoint; new=${fresh} existing=${existing}. Inspect claude_channel.session.fresh_launch_probe.`);
  }
  if (claude.session && claude.session.action === "claude_auth_required") {
    actions.push("Authenticate Claude Code with channel auth login before live teammate startup");
  }
  return [...new Set(actions)].slice(0, 8);
}

function cockpitSnapshot(cwd, options = {}) {
  state.init(cwd);
  const goals = state.listGoals(cwd);
  const tasks = state.listTasks(cwd);
  const runs = state.listRuns(cwd);
  const plans = planningSummaries(cwd, goals);
  const mode = inferMode(goals, tasks, plans);
  const activeTasks = tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).map(compactTask);
  const blockers = proofBlockers(cwd, tasks);
  const events = state.listEvents(cwd, { limit: options.event_limit || 8 }).map(compactEvent);
  const worktrees = listWorktrees(cwd);
  const moa = listMoa(cwd);
  const agentTeams = listAgentTeamImports(cwd);
  const codexSubagents = listCodexSubagentImports(cwd);
  const pendingCheckins = listCheckins(cwd, { agent: "claude", ack_status: "new", requires_codex_attention: true, limit: 5 });
  const pendingSelfHeal = listSelfHealRecommendations(cwd, { status: "recommended", limit: 5 });
  const pendingRefactorOffers = listRefactorOffers(cwd, { status: "offered", limit: 5 });
  const mailbox = mailboxState(cwd, tasks);
  const daemon = daemonStatus(cwd);
  const codexWake = codexWakeState(cwd);
  const claudeMcp = claudeMcpState(cwd);
  const codexMcp = statusCodexMcp(cwd);
  const messageTimeline = messageTimelineState(cwd, { limit: options.timeline_limit || 8 });
  const session = channelSession(cwd);
  const target = options.target || (session && (session.target || session.name));
  const channelCwd = (session && session.project_dir) || cwd;
  if (options.scan_notices !== false) scanClaudeNotices(cwd, { project_dirs: [cwd, channelCwd] });
  const notices = listNotices(cwd, { status: "new", limit: 5 });
  const runtime = options.live_channel === false ? { checked: false, reason: "disabled" } : liveChannelStatus(channelCwd, target);
  const claude = {
    session,
    runtime,
    agents:
      options.live_channel === false
        ? { checked: false, reason: "disabled" }
        : claudeAgentSessions(channelCwd, session && session.name),
    queues: channelQueues(cwd, tasks)
  };
  return {
    generated_at: new Date().toISOString(),
    operator: "codex",
    mode,
    goals: goals.map((goal) => ({
      goal_id: goal.goal_id,
      title: goal.title,
      status: goal.status
    })),
    planning: plans,
    tasks: {
      total: tasks.length,
      by_status: statusCounts(tasks),
      by_owner: ownerCounts(tasks),
      active: activeTasks,
      done: tasks.filter((task) => task.status === "done").length,
      proof_blockers: blockers
    },
    runs: {
      total: runs.length,
      active: runs.filter((run) => run.status === "active").map((run) => ({
        run_id: run.run_id,
        kind: run.kind,
        title: run.title,
        owner: run.owner,
        mode: run.mode,
        goal_id: run.goal_id,
        task_id: run.task_id,
        started_at: run.started_at,
        updated_at: run.updated_at
      })),
      recent: runs.slice(-5).map((run) => ({
        run_id: run.run_id,
        kind: run.kind,
        title: run.title,
        status: run.status,
        owner: run.owner,
        goal_id: run.goal_id,
        task_id: run.task_id,
        updated_at: run.updated_at
      }))
    },
    worktrees: {
      total: worktrees.length,
      active: worktrees.filter((worktree) => !["removed", "merged"].includes(worktree.status)).map((worktree) => ({
        task_id: worktree.task_id,
        status: worktree.status,
        branch: worktree.branch,
        worktree_path: worktree.worktree_path
      })),
      merged: worktrees.filter((worktree) => worktree.status === "merged").length
    },
    moa: {
      total: moa.length,
      recent: moa.slice(-5).map((council) => ({
        council_id: council.council_id,
        scope: council.scope,
        subject_id: council.subject_id,
        kind: council.kind,
        participants: council.participants.map((participant) => participant.agent),
        decision_owner: council.synthesis.decision_owner,
        advisory_only: council.advisory_only
      }))
    },
    agent_teams: {
      total: agentTeams.length,
      recent: agentTeams.slice(-5).map((record) => ({
        import_id: record.import_id,
        task_id: record.task_id,
        facet: record.facet,
        subagents: record.subagents.map((agent) => agent.name),
        advisory_only: record.advisory_only,
        codex_state_authority: record.codex_state_authority
      }))
    },
    codex_subagents: {
      total: codexSubagents.length,
      recent: codexSubagents.slice(-5).map((record) => ({
        import_id: record.import_id,
        task_id: record.task_id,
        task_owner: record.task_owner,
        facet: record.facet,
        subagents: record.subagents.map((agent) => agent.name),
        advisory_only: record.advisory_only,
        execution_evidence: record.execution_evidence,
        codex_state_authority: record.codex_state_authority
      }))
    },
    claude_steering: {
      pending: notices.length,
      recent: notices.map((notice) => ({
        notice_id: notice.notice_id,
        title: notice.title,
        task_id: notice.task_id,
        goal_id: notice.goal_id,
        source_path: notice.source_path,
        discovered_at: notice.discovered_at
      }))
    },
    agent_checkins: {
      pending_steering: pendingCheckins.length,
      recent: pendingCheckins.map((checkin) => ({
        checkin_id: checkin.checkin_id,
        agent: checkin.agent,
        work_status: checkin.work_status,
        ack_status: checkin.ack_status,
        task_id: checkin.task_id,
        goal_id: checkin.goal_id,
        run_id: checkin.run_id,
        summary: checkin.summary,
        steer: checkin.steer,
        recorded_at: checkin.recorded_at
      }))
    },
    self_heal: {
      pending: pendingSelfHeal.length,
      recent: pendingSelfHeal.map((recommendation) => ({
        recommendation_id: recommendation.recommendation_id,
        type: recommendation.type,
        source: recommendation.source,
        target_surface: recommendation.target_surface,
        change_request: recommendation.change_request,
        title: recommendation.title,
        goal_id: recommendation.goal_id,
        task_id: recommendation.task_id,
        requires_user_confirmation: recommendation.requires_user_confirmation
      }))
    },
    refactor_offers: {
      pending: pendingRefactorOffers.length,
      recent: pendingRefactorOffers.map((offer) => ({
        offer_id: offer.offer_id,
        title: offer.title,
        goal_id: offer.goal_id,
        task_id: offer.task_id,
        prompt_sha256: offer.prompt_sha256,
        requires_user_confirmation: offer.requires_user_confirmation
      }))
    },
    mailbox,
    message_timeline: messageTimeline,
    daemon: {
      running: daemon.running,
      stale_pid: daemon.stale_pid,
      pid_record: daemon.pid_record,
      session_push: daemon.session_push,
      codex_wake: codexWake,
      codex_mcp: codexMcp,
      claude_mcp: claudeMcp,
      active_runs: daemon.active_runs.map((run) => ({
        run_id: run.run_id,
        status: run.status,
        title: run.title,
        started_at: run.started_at,
        updated_at: run.updated_at,
        metadata: run.metadata
      })),
      log_path: daemon.log_path,
      error_log_path: daemon.error_log_path
    },
    claude_channel: claude,
    latest_events: events,
    next_actions: topNextActions(
      mode,
      goals,
      activeTasks,
      plans,
      claude,
      blockers,
      notices,
      pendingCheckins,
      pendingSelfHeal,
      pendingRefactorOffers,
      mailbox,
      { ...daemon, codex_wake: codexWake }
    )
  };
}

function renderCockpit(snapshot) {
  const statusParts = Object.entries(snapshot.tasks.by_status)
    .sort()
    .map(([status, count]) => `${status}:${count}`)
    .join(" ");
  const ownerParts = Object.entries(snapshot.tasks.by_owner)
    .sort()
    .map(([owner, count]) => `${owner}:${count}`)
    .join(" ");
  const channel = snapshot.claude_channel.session;
  const runtime = snapshot.claude_channel.runtime;
  const liveChecked = !(runtime && runtime.checked === false);
  const liveOk = Boolean(runtime && runtime.ok);
  const presenceOk = Boolean(runtime && runtime.presence_ok);
  const channelState = channel
    ? liveChecked
      ? liveOk
        ? "ready"
        : presenceOk
          ? "loaded-channel-unverified"
        : "not-live"
      : channel.ok
        ? "last-known-ready"
        : "last-known-not-ready"
    : "no-session";
  const channelLine = channel
    ? `${channelState} action=${channel.action || "unknown"} target=${channel.target || channel.name || "unknown"}${channel.session_identity && channel.session_identity.thread_ref ? ` identity=${channel.session_identity.thread_ref}` : ""} reply=${channel.reply_ready}`
    : "no session yet";
  const runtimeLine = liveChecked
    ? `live-ok=${liveOk}${presenceOk ? " presence=loaded" : ""}${runtime && runtime.status_kind ? ` status=${runtime.status_kind}` : ""}`
    : `live-check=${runtime.reason}`;
  const agents = snapshot.claude_channel.agents;
  const agentsLine =
    agents && agents.checked === false
      ? `live-check=${agents.reason}`
      : agents && Array.isArray(agents.sessions) && agents.sessions.length
        ? agents.sessions
            .map((session) => `${session.name || session.id || "claude"}:${session.state || session.status || session.kind || "unknown"}`)
            .join(" ")
        : "none visible";
  const sections = [
    "# Codex Agent Team Cockpit",
    "",
    `Generated: ${snapshot.generated_at}`,
    `Mode: ${snapshot.mode}`,
    `Claude: ${channelLine} ${runtimeLine}`,
    `Claude startup: ${channelStartupLine(channel)}`,
    `Claude agents: ${agentsLine}`,
    `Receiver daemon: ${snapshot.daemon.running ? "running" : "not-running"} active-runs=${snapshot.daemon.active_runs.length}${snapshot.daemon.stale_pid ? " stale-pid=true" : ""}`,
    `Session push: ${snapshot.daemon.session_push && snapshot.daemon.session_push.native_model_ui_push ? "native" : "mailbox-daemon"} fallback=${snapshot.daemon.session_push ? snapshot.daemon.session_push.fallback_waiter : "await reply --request-id <id>"}`,
    `Claude MCP: queued=${snapshot.daemon.claude_mcp.queued_total} waiting=${snapshot.daemon.claude_mcp.waiting_for_mcp_server} mcp-emitted=${snapshot.daemon.claude_mcp.mcp_emitted} legacy-fallback=${snapshot.daemon.claude_mcp.legacy_fallback_attempts} legacy-blocked=${snapshot.daemon.claude_mcp.legacy_blocked} outbox=${snapshot.daemon.claude_mcp.outbox_path}`,
    `Codex MCP: configured=${snapshot.daemon.codex_mcp.configured ? "yes" : "no"} wrapper=${snapshot.daemon.codex_mcp.wrapper_exists ? "yes" : "no"} pending-wake=${snapshot.daemon.codex_mcp.pending_wake_count} manifest=${path.relative(process.cwd(), snapshot.daemon.codex_mcp.manifest_path)}`,
    `Codex wake: total=${snapshot.daemon.codex_wake.total} delivered=${snapshot.daemon.codex_wake.delivered} queued-no-adapter=${snapshot.daemon.codex_wake.queued_no_adapter} failed=${snapshot.daemon.codex_wake.failed} adapter=${snapshot.daemon.codex_wake.adapter_configured ? "configured" : "missing"} stream=${snapshot.daemon.codex_wake.stream_path}`,
    `Timeline: shown=${snapshot.message_timeline.shown} candidates=${snapshot.message_timeline.total_candidates}`,
    `Queues: requests=${snapshot.claude_channel.queues.requests} responses=${snapshot.claude_channel.queues.responses} pending=${snapshot.claude_channel.queues.pending.length}${snapshot.claude_channel.queues.stale_completed_pending ? ` completed-stale=${snapshot.claude_channel.queues.stale_completed_pending}` : ""}`,
    `Mailbox: total=${snapshot.mailbox.total} codex-unread=${snapshot.mailbox.codex_unread} claude-unread=${snapshot.mailbox.claude_unread} pending-receipts=${snapshot.mailbox.pending_receipt_ack} pending-replies=${snapshot.mailbox.pending_reply_required}${snapshot.mailbox.stale_completed_unread || snapshot.mailbox.stale_completed_receipt_ack || snapshot.mailbox.stale_completed_reply_required ? ` completed-stale=${snapshot.mailbox.stale_completed_unread + snapshot.mailbox.stale_completed_receipt_ack + snapshot.mailbox.stale_completed_reply_required}` : ""}${snapshot.mailbox.duplicate_receipt_acks_collapsed ? ` receipt-duplicates-collapsed=${snapshot.mailbox.duplicate_receipt_acks_collapsed}` : ""} malformed=${snapshot.mailbox.diagnostics.malformed_total}`,
    `Tasks: total=${snapshot.tasks.total} ${statusParts || "none"}`,
    `Runs: total=${snapshot.runs.total} active=${snapshot.runs.active.length}`,
    `Owners: ${ownerParts || "none"}`,
    `Worktrees: total=${snapshot.worktrees.total} active=${snapshot.worktrees.active.length} merged=${snapshot.worktrees.merged}`,
    `Codex Subagents: imports=${snapshot.codex_subagents.total}`,
    `Agent Teams: imports=${snapshot.agent_teams.total}`,
    `Claude Steering: pending=${snapshot.claude_steering.pending}`,
    `Agent Check-ins: pending-steering=${snapshot.agent_checkins.pending_steering}`,
    `Self-Heal: pending=${snapshot.self_heal.pending}`,
    `Refactor Offers: pending=${snapshot.refactor_offers.pending}`,
    `MoA: advisory-records=${snapshot.moa.total}`,
    "",
    "## Next Actions",
    "",
    ...(snapshot.next_actions.length ? snapshot.next_actions.map((action) => `- ${action}`) : ["- None"]),
    "",
    "## Active Tasks",
    "",
    ...(snapshot.tasks.active.length
      ? snapshot.tasks.active.map((task) => `- ${task.task_id} [${task.status}] ${task.owner} -> ${task.reviewer}: ${task.title}`)
      : ["- None"]),
    "",
    "## Proof Blockers",
    "",
    ...(snapshot.tasks.proof_blockers.length
      ? snapshot.tasks.proof_blockers.map((blocker) => `- ${blocker.task_id}: ${blocker.blocker} (${blocker.next_command})`)
      : ["- None"]),
    "",
    "## Coordination Runs",
    "",
    ...(snapshot.runs.recent.length
      ? snapshot.runs.recent.map((run) => `- ${run.run_id} [${run.status}] ${run.kind} owner=${run.owner || "unknown"}${run.task_id ? ` task=${run.task_id}` : ""}: ${run.title}`)
      : ["- None"]),
    "",
    "## Worktrees",
    "",
    ...(snapshot.worktrees.active.length
      ? snapshot.worktrees.active.map((worktree) => `- ${worktree.task_id} [${worktree.status}] ${worktree.branch} ${worktree.worktree_path}`)
      : ["- None active"]),
    "",
    "## MoA Advisory",
    "",
    ...(snapshot.moa.recent.length
      ? snapshot.moa.recent.map((council) => `- ${council.council_id} ${council.kind} ${council.scope}:${council.subject_id} owner=${council.decision_owner}`)
      : ["- None"]),
    "",
    "## Claude Agent Teams",
    "",
    ...(snapshot.agent_teams.recent.length
      ? snapshot.agent_teams.recent.map((record) => `- ${record.import_id} ${record.task_id} subagents=${record.subagents.join(",") || "none"} authority=codex`)
      : ["- None"]),
    "",
    "## Codex Subagents",
    "",
    ...(snapshot.codex_subagents.recent.length
      ? snapshot.codex_subagents.recent.map((record) => `- ${record.import_id} ${record.task_id} owner=${record.task_owner} subagents=${record.subagents.join(",") || "none"} evidence=${record.execution_evidence}`)
      : ["- None"]),
    "",
    "## Codex Mailbox",
    "",
    ...(snapshot.mailbox.codex_inbox.length
      ? snapshot.mailbox.codex_inbox.map((message) => `- ${message.id}${message.task_id ? ` ${message.task_id}` : ""} ${message.from}->${message.to}/${message.kind}${message.informational ? " advisory" : ""}${message.semantic_ack_required ? " semantic-reply-required" : ""}: ${message.subject || message.body_preview || "message"}`)
      : ["- None"]),
    "",
    "## Receiver Daemon",
    "",
    ...(snapshot.daemon.active_runs.length
      ? snapshot.daemon.active_runs.map((run) => `- ${run.run_id} [${run.status}] ${run.title} roles=${(run.metadata && run.metadata.roles || []).join(",") || "unknown"}`)
      : [`- ${snapshot.daemon.running ? "Running without active run record" : "Not running"}`]),
    "",
    "## Codex Wake Stream",
    "",
    ...(snapshot.daemon.codex_wake.recent.length
      ? snapshot.daemon.codex_wake.recent.map((wake) => `- ${wake.message_id}${wake.task_id ? ` ${wake.task_id}` : ""} ${wake.from}->${wake.to}/${wake.kind} ${wake.result_state}: ${wake.subject || wake.payload_path}`)
      : [`- No wake payloads yet (${snapshot.daemon.codex_wake.stream_path})`]),
    "",
    "## Message Timeline",
    "",
    ...(snapshot.message_timeline.rows.length
      ? snapshot.message_timeline.rows.map((row) => {
          const stages = row.stages.map((stage) => `${stage.type}${stage.result_state ? `(${stage.result_state})` : ""}`).join(" -> ");
          return `- ${row.message_id}${row.task_id ? ` ${row.task_id}` : ""} ${row.from || "?"}->${row.to || "?"}/${row.kind || "?"} ${row.current_state}: ${stages}`;
        })
      : ["- None"]),
    "",
    "## Codex MCP Adapter",
    "",
    `- configured=${snapshot.daemon.codex_mcp.configured} wrapper=${snapshot.daemon.codex_mcp.wrapper_exists} pending-wake=${snapshot.daemon.codex_mcp.pending_wake_count}`,
    `- wrapper: ${snapshot.daemon.codex_mcp.wrapper_path}`,
    `- manifest: ${snapshot.daemon.codex_mcp.manifest_path}`,
    "",
    "## Claude MCP Outbox",
    "",
    ...(snapshot.daemon.claude_mcp.recent.length
      ? snapshot.daemon.claude_mcp.recent.map((row) => `- ${row.message_id}${row.task_id ? ` ${row.task_id}` : ""} ${row.kind} ${row.state}: ${row.notification_id}`)
      : [`- No first-party Claude MCP wake-ups yet (${snapshot.daemon.claude_mcp.outbox_path})`]),
    "",
    "## Claude Pending Inbox",
    "",
    ...(snapshot.mailbox.claude_inbox.length
      ? snapshot.mailbox.claude_inbox.map((message) => `- ${message.id}${message.task_id ? ` ${message.task_id}` : ""} ${message.from}->${message.to}/${message.kind}: ${message.subject || message.body_preview || "message"}`)
      : ["- None"]),
    "",
    "## Receipt ACKs",
    "",
    ...(snapshot.mailbox.recent_receipt_acks.length
      ? snapshot.mailbox.recent_receipt_acks.map((message) => `- ${message.id}${message.task_id ? ` ${message.task_id}` : ""} ${message.from}->${message.to}: ${message.subject || message.body_preview || "receipt ACK"}`)
      : ["- None"]),
    "",
    "## Claude Check-ins",
    "",
    ...(snapshot.mailbox.recent_claude_checkins.length
      ? snapshot.mailbox.recent_claude_checkins.map((message) => `- ${message.id}${message.task_id ? ` ${message.task_id}` : ""} ${message.kind}: ${message.subject || message.body_preview || "check-in"}`)
      : ["- None"]),
    "",
    "## Claude Steering Notices",
    "",
    ...(snapshot.claude_steering.recent.length
      ? snapshot.claude_steering.recent.map((notice) => `- ${notice.notice_id}${notice.task_id ? ` ${notice.task_id}` : ""}: ${notice.title} (${notice.source_path})`)
      : ["- None"]),
    "",
    "## Agent Check-ins",
    "",
    ...(snapshot.agent_checkins.recent.length
      ? snapshot.agent_checkins.recent.map((checkin) => `- ${checkin.checkin_id}${checkin.task_id ? ` ${checkin.task_id}` : ""} ${checkin.agent}/${checkin.work_status}: ${checkin.steer || checkin.summary}`)
      : ["- None"]),
    "",
    "## Self-Heal Recommendations",
    "",
    ...(snapshot.self_heal.recent.length
      ? snapshot.self_heal.recent.map((item) => `- ${item.recommendation_id}${item.task_id ? ` ${item.task_id}` : ""} ${item.source || "unknown"}/${item.type || "self_heal"} surface=${item.target_surface || "harness"}: ${item.title} confirmation=${item.requires_user_confirmation}`)
      : ["- None"]),
    "",
    "## Refactor Offers",
    "",
    ...(snapshot.refactor_offers.recent.length
      ? snapshot.refactor_offers.recent.map((offer) => `- ${offer.offer_id}${offer.task_id ? ` ${offer.task_id}` : ""}: ${offer.title} confirmation=${offer.requires_user_confirmation}`)
      : ["- None"]),
    "",
    "## Latest Events",
    "",
    ...(snapshot.latest_events.length
      ? snapshot.latest_events.map((event) => `- ${event.recorded_at} ${event.type}${event.task_id ? ` ${event.task_id}` : ""}${event.run_id ? ` ${event.run_id}` : ""}${event.goal_id && !event.task_id && !event.run_id ? ` ${event.goal_id}` : ""}`)
      : ["- None"])
  ];
  return sections.join("\n");
}

module.exports = {
  cockpitSnapshot,
  renderCockpit
};
