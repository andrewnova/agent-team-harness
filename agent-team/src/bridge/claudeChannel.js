const path = require("node:path");
const manual = require("./manual");
const {
  findCli,
  findClaudeCli,
  canonicalPath
} = require("./claudeChannel/utils");
const { workspaceCwd } = require("./claudeChannel/status");
const {
  auth,
  authHelp,
  channelsFlagCheck,
  claudeAuthStatus,
  claudeVersion
} = require("./claudeChannel/auth");
const { installBridge } = require("./claudeChannel/install");
const {
  createLaunchId,
  startupProofDiagnostics,
  waitForBootAck,
  waitForLaunchMarker,
  waitForMcpInitialized,
  waitForMcpStarted
} = require("./claudeChannel/boot");
const {
  codexSessionIdentity,
  defaultSessionName,
  launchBackground,
  launchCodexTerminal,
  launchPty,
  launchVisible
} = require("./claudeChannel/launcher");
const { loadEnsureSession, persistEnsure } = require("./claudeChannel/session");
const { createStartupPacket } = require("./claudeChannel/startupPacket");
const { statusClaudeMcp } = require("../mcp/claudeInstall");

// Liveness probe for a recorded session: the MCP server runs iff the Claude
// session is alive, and its start proof row carries that server's pid. A recorded
// session is only reusable if that process is still running — otherwise "reuse"
// would report a closed window as delivery_ready and steer into the void.
function sessionProcessAlive(cwd, session) {
  const launchId = session && session.launch_id;
  if (!launchId) return false;
  const proof = startupProofDiagnostics(cwd, launchId);
  const mcpStart = proof && proof.selected && proof.selected.mcp_start;
  const pid = mcpStart && mcpStart.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH => the process is gone; EPERM => it exists but is owned by another user.
    return err.code === "EPERM";
  }
}

function channelDiagnosticHint(authStatus, status) {
  if (status && status.operator_hint) {
    const hint = { ...status.operator_hint };
    if (authStatus && !authStatus.ok) {
      hint.auth_note =
        "This same restricted context may also make Claude auth look logged out. Run channel auth/login and channel doctor from the same local-permission context before deciding auth is still broken.";
    }
    return hint;
  }
  if (authStatus && !authStatus.ok) {
    return {
      kind: "claude_auth_unverified",
      confidence: "medium",
      reason: "Claude Code auth could not be verified in this process.",
      next_step:
        "Run channel auth login through the harness, then rerun channel doctor/status from the same local-permission context before delegating Claude-owned work.",
      blocking_for_claiming_claude_working: true
    };
  }
  return null;
}

function sessionMatchesTarget(session, target) {
  if (!target) return true;
  if (!session) return false;
  return [session.name, session.target, session.launch_id].filter(Boolean).includes(target);
}

function firstPartyStatus(cwd, target = null, options = {}) {
  const session = loadEnsureSession(cwd);
  const mcp = statusClaudeMcp(cwd, options);
  const matches = sessionMatchesTarget(session, target);
  const proof = session && session.launch_id ? startupProofDiagnostics(cwd, session.launch_id) : null;
  const launchMarker = session?.launch_marker || (proof && proof.selected.launch_marker ? { ok: true, record: proof.selected.launch_marker } : null);
  const mcpStart = session?.mcp_start || (proof && proof.selected.mcp_start ? { ok: true, record: proof.selected.mcp_start } : null);
  const mcpInit = session?.mcp_init || (proof && proof.selected.mcp_init ? { ok: true, record: proof.selected.mcp_init } : null);
  const bootAck = session?.boot_ack || (proof && proof.selected.boot_ack ? { ok: true, record: proof.selected.boot_ack } : null);
  const deliveryReady = Boolean(matches && mcp.ok && (mcpInit?.ok || bootAck?.ok));
  const visibleLoaded = Boolean(matches && launchMarker?.ok);
  return {
    ok: deliveryReady || visibleLoaded,
    delivery_ready: deliveryReady,
    visible_loaded: visibleLoaded,
    transport: "first_party_agent_team_mcp",
    target: target || session?.target || session?.name || null,
    session_name: session?.name || null,
    launch_id: session?.launch_id || null,
    session_path: session ? "recorded" : null,
    first_party_mcp: mcp,
    launch_marker: launchMarker || { ok: false, reason: session ? "not_recorded" : "no_session" },
    mcp_start: mcpStart || { ok: false, reason: session ? "not_recorded" : "no_session" },
    mcp_init: mcpInit || { ok: false, reason: session ? "not_recorded" : "no_session" },
    boot_ack: bootAck || { ok: false, reason: session ? "not_recorded" : "no_session" },
    startup_proof: proof,
    operator_hint:
      !mcp.ok
        ? {
            kind: "first_party_mcp_not_configured",
            reason: "Install/register the first-party Agent Team Claude MCP wrapper, then restart visible Claude.",
            next_step: "agent-team channel mcp install",
            blocking_for_claiming_claude_working: true
          }
        : !session
          ? {
              kind: "visible_claude_not_started",
              reason: "No Agent Team Claude startup session has been recorded.",
              next_step: "agent-team start --daemon or agent-team channel ensure",
              blocking_for_claiming_claude_working: true
            }
          : !matches
            ? {
                kind: "target_mismatch",
                reason: "A Claude startup session exists, but it does not match the requested target/name.",
                next_step: "Run channel ensure with the requested --name/--project-dir.",
                blocking_for_claiming_claude_working: true
              }
            : undefined
  };
}

function firstPartyList(cwd, options = {}) {
  const session = loadEnsureSession(cwd);
  return {
    ok: true,
    transport: "first_party_agent_team_mcp",
    sessions: session
      ? [
          {
            name: session.name,
            target: session.target,
            launch_id: session.launch_id,
            project_dir: session.project_dir,
            action: session.action,
            delivery_ready: session.delivery_ready,
            visible_loaded: session.visible_loaded,
            updated_at: session.updated_at
          }
        ]
      : [],
    first_party_mcp: statusClaudeMcp(cwd, options)
  };
}

function proofResult(current, selected) {
  if (current && current.ok) return current;
  if (!selected) return current;
  return {
    ok: true,
    record: selected,
    recovered_from_startup_proof: true
  };
}

function attachStartupProof(cwd, launchId, record) {
  const proof = startupProofDiagnostics(cwd, launchId);
  return {
    ...record,
    launch_marker: proofResult(record.launch_marker, proof.selected.launch_marker),
    mcp_start: proofResult(record.mcp_start, proof.selected.mcp_start),
    mcp_init: proofResult(record.mcp_init, proof.selected.mcp_init),
    boot_ack: proofResult(record.boot_ack, proof.selected.boot_ack),
    startup_proof: proof
  };
}

function diagnose(cwd, options = {}) {
  const claude = findClaudeCli();
  const target = options.target || defaultSessionName(cwd);
  const issues = [];
  const claudeCheck = {
    ok: claude.ok,
    path: claude.path,
    reason: claude.reason
  };
  if (!claude.ok) issues.push(claude.reason);
  const version = claude.ok ? claudeVersion(claude, cwd) : null;
  const authStatus = claude.ok ? claudeAuthStatus(claude, cwd) : null;
  if (authStatus && !authStatus.ok) issues.push("Claude Code auth is not logged in or cannot be verified");
  const channels = claude.ok ? channelsFlagCheck(claude, cwd, options) : null;
  if (channels && !channels.ok) issues.push("Claude Code did not accept the first-party Agent Team MCP channel launch flags");
  const mcpStatus = statusClaudeMcp(cwd, options);
  if (!mcpStatus.ok) issues.push("First-party Agent Team Claude MCP server is not installed/configured");
  const status = firstPartyStatus(cwd, target, options);
  if (status && !status.ok) issues.push(`No first-party Claude MCP startup proof resolved for target ${target}`);
  const smoke = options.smoke ? { ok: false, skipped: true, reason: "raw synchronous smoke was removed; use channel steer --recover-visible" } : null;
  const hint = channelDiagnosticHint(authStatus, status);
  return {
    ok: issues.length === 0,
    checked_at: new Date().toISOString(),
    target,
    transport: "first_party_agent_team_mcp",
    claude_code: claudeCheck,
    claude_version: version,
    claude_auth: authStatus,
    auth_help: authStatus && !authStatus.ok ? authHelp(cwd, options) : null,
    channels_flag: channels,
    first_party_mcp: mcpStatus,
    endpoint_list: firstPartyList(cwd, options),
    endpoint_status: status,
    reply_ready: "mailbox_required",
    smoke,
    operator_hint: hint,
    issues
  };
}

function ensure(cwd, options = {}) {
  const inferredDefaultName = !(options.name || options.target);
  const identity = codexSessionIdentity();
  const name = options.name || options.target || defaultSessionName(cwd);
  const target = options.target || name;
  const projectCwd = workspaceCwd(cwd, options);
  const strictSessionIdentity = Boolean(inferredDefaultName && identity && identity.token && !options.allow_cross_project_reuse);
  const previousSession = loadEnsureSession(cwd, { name, target, projectCwd });
  const baseRecord = {
    name,
    target,
    project_dir: projectCwd,
    harness_cwd: path.resolve(cwd),
    session_identity: identity
      ? {
          source: identity.source,
          thread_ref: identity.token,
          strict_project_reuse: strictSessionIdentity
        }
        : null
  };
  const persist = (record) => {
    const { endpoint_selection: endpointSelection, ...rest } = record;
    return persistEnsure(cwd, {
      ...baseRecord,
      ...rest,
      endpoint_selection: {
        transport: "first_party_agent_team_mcp",
        display_name: name,
        target,
        project_dir: projectCwd,
        strict_session_identity: strictSessionIdentity,
        allow_cross_project_reuse: Boolean(options.allow_cross_project_reuse),
        fresh_claude: Boolean(options.fresh_claude),
        reuse_claude: Boolean(options.reuse_claude),
        ...(endpointSelection || {})
      }
    });
  };
  const timeoutMs = options.timeout_ms || 45000;
  const pollMs = options.poll_ms || 1000;

  // Adopt-first: by default, reuse a recorded session for this project+name when its
  // process is still alive, instead of launching another visible window every time
  // (--fresh-claude forces a new launch; the liveness probe keeps us from adopting a
  // closed window). This is what stops the "N launches per session" churn.
  if (!options.fresh_claude && previousSession && previousSession.ok) {
    const sameProject = previousSession.project_dir && canonicalPath(previousSession.project_dir) === canonicalPath(projectCwd);
    const sameName = previousSession.name === name || previousSession.target === target;
    if (sameProject && sameName && sessionProcessAlive(cwd, previousSession)) {
      const proof = previousSession.launch_id ? startupProofDiagnostics(cwd, previousSession.launch_id) : null;
      return persist({
        ok: true,
        action: "reused_recorded_first_party_session",
        identity_confidence: "recorded_first_party_session_reused",
        endpoint_selection: {
          strategy: "explicit_reuse_recorded_session",
          selected_target: target,
          selected_endpoint: null,
          proof
        },
        launch_id: previousSession.launch_id,
        launch_mode: previousSession.launch_mode,
        delivery_ready: Boolean(previousSession.delivery_ready || previousSession.mcp_init?.ok || previousSession.boot_ack?.ok),
        visible_loaded: Boolean(previousSession.visible_loaded || previousSession.launch_marker?.ok),
        launch_marker: previousSession.launch_marker,
        mcp_start: previousSession.mcp_start,
        mcp_init: previousSession.mcp_init,
        boot_ack: previousSession.boot_ack,
        startup_proof: proof,
        status: firstPartyStatus(cwd, target, options),
        reply_ready: "mailbox_required"
      });
    }
  }

  const claude = findClaudeCli();
  if (!claude.ok) {
    return persist({
      ok: false,
      action: "missing_claude_cli",
      reason: claude.reason,
      endpoint_selection: { strategy: "preflight_missing_claude_cli" },
      status: firstPartyStatus(cwd, target, options)
    });
  }
  const authStatus = claudeAuthStatus(claude, projectCwd);
  // Only a DEFINITE logged-out result blocks the launch. An "unverifiable" probe
  // (sandboxed shell, timeout, non-JSON output) must not masquerade as logged-out:
  // the visible Claude launched in the user's own terminal usually has valid auth,
  // and the boot-ack / MCP proof chain will surface a genuine auth failure if there
  // is one. This replaces the prose "Codex App sandbox rule" with real behavior.
  if (authStatus.status === "logged_out") {
    return persist({
      ok: false,
      action: "claude_auth_required",
      reason: "Claude Code reports it is not logged in",
      endpoint_selection: { strategy: "preflight_claude_auth" },
      claude_path: claude.path,
      claude_auth: authStatus,
      auth_help: authHelp(projectCwd, options),
      status: firstPartyStatus(cwd, target, options)
    });
  }
  const launchOptions = {
    ...options,
    harness_cwd: path.resolve(cwd),
    launch_id: options.launch_id || createLaunchId(name, projectCwd)
  };
  const launchMode = options.launch_mode || "visible";
  launchOptions.launch_mode = launchMode;
  if (!["codex-terminal", "visible", "pty", "background"].includes(launchMode)) {
    return persist({
      ok: false,
      action: "invalid_launch_mode",
      reason: "launch_mode must be codex-terminal, visible, pty, or background",
      endpoint_selection: { strategy: "preflight_invalid_launch_mode" },
      status: firstPartyStatus(cwd, target, options)
    });
  }
  const started =
    launchMode === "codex-terminal"
      ? launchCodexTerminal(claude, projectCwd, name, launchOptions)
      : launchMode === "visible"
        ? launchVisible(claude, projectCwd, name, launchOptions)
        : launchMode === "background"
          ? launchBackground(claude, projectCwd, name, launchOptions)
          : launchPty(claude, projectCwd, name, launchOptions);
  if (!started.ok) {
    return persist({
      ok: false,
      action: "start_failed",
      claude_path: claude.path,
      endpoint_selection: { strategy: "launch_failed" },
      start: started,
      background: started.background,
      status: firstPartyStatus(cwd, target, options)
    });
  }
  const markerWaitMs =
    launchMode === "visible" || launchMode === "codex-terminal"
      ? options.launch_marker_timeout_ms === undefined
        ? Math.min(2000, timeoutMs)
        : options.launch_marker_timeout_ms
      : 0;
  const launchMarker = waitForLaunchMarker(cwd, launchOptions.launch_id, markerWaitMs, Math.min(pollMs, 100));
  const handshakeWaitMs =
    launchMode === "visible" || launchMode === "codex-terminal"
      ? options.handshake_timeout_ms === undefined
        ? Math.min(3000, timeoutMs)
        : options.handshake_timeout_ms
      : 0;
  const mcpStart = waitForMcpStarted(cwd, launchOptions.launch_id, handshakeWaitMs, Math.min(pollMs, 100));
  const mcpInit = mcpStart.ok
    ? waitForMcpInitialized(cwd, launchOptions.launch_id, handshakeWaitMs, Math.min(pollMs, 100))
    : { ok: false, reason: "mcp_start_not_recorded", launch_id: launchOptions.launch_id };
  const bootAckWaitMs =
    launchMode === "visible" || launchMode === "codex-terminal"
      ? options.boot_ack_timeout_ms === undefined
        ? Math.min(5000, timeoutMs)
        : options.boot_ack_timeout_ms
      : options.boot_ack_timeout_ms || 0;
  const bootAck = waitForBootAck(cwd, launchOptions.launch_id, bootAckWaitMs, Math.min(pollMs, 100));
  const deliveryReady = Boolean(mcpInit.ok || bootAck.ok);
  const visibleStarted = Boolean(launchMarker.ok && (started.mode === "visible" || started.mode === "codex-terminal"));
  const channelAcceptable = deliveryReady || (!options.smoke && visibleStarted);
  const smoke = options.smoke
    ? {
        ok: bootAck.ok,
        method: "first_party_boot_ack",
        reason: bootAck.ok ? undefined : "boot_ack_not_recorded"
      }
    : null;
  const record = {
    ok: channelAcceptable && (!smoke || smoke.ok),
    identity_confidence: deliveryReady ? "first_party_mcp_started" : visibleStarted ? "visible_launch_started" : "launch_unverified",
    launch_id: launchOptions.launch_id,
    action:
      smoke && !smoke.ok
        ? "started_boot_ack_missing"
        : deliveryReady
          ? "started_first_party_mcp"
          : visibleStarted
            ? "started_visible_mcp_pending"
            : "started_unproven",
    target,
    endpoint_selection: {
      strategy: "visible_launch_first_party_mcp",
      selected_target: target,
      selected_endpoint: null,
      selected_launch_id: launchOptions.launch_id
    },
    delivery_ready: deliveryReady,
    visible_loaded: visibleStarted,
    launch_mode: started.mode,
    launch_marker: launchMarker,
    mcp_start: mcpStart,
    mcp_init: mcpInit,
    boot_ack: bootAck,
    claude_path: claude.path,
    start: started,
    background: started.background,
    status: firstPartyStatus(cwd, target, options),
    command: started.command,
    reply_ready: "mailbox_required",
    smoke
  };
  const reconciled = attachStartupProof(cwd, launchOptions.launch_id, record);
  if (reconciled.launch_marker.ok && !reconciled.boot_ack.ok) {
    reconciled.fallback_packet = createStartupPacket(cwd, { launch_id: launchOptions.launch_id, session: reconciled });
  }
  return persist(reconciled);
}

function create() {
  const base = manual.create();
  return {
    name: "claude-channel",
    status(target, cwd = process.cwd()) {
      return firstPartyStatus(cwd, target);
    },
    list(cwd = process.cwd()) {
      return firstPartyList(cwd);
    },
    diagnose,
    install(cwd, options = {}) {
      return installBridge({ ...options, cwd });
    },
    ensure,
    request(cwd, request) {
      const row = base.request(cwd, { ...request, adapter: "claude-channel", channel_command: "removed" });
      const response = {
        request_id: row.request_id,
        task_id: request.task_id,
        kind: request.kind,
        adapter: "claude-channel",
        result_state: "failed",
        status: "removed",
        exit_code: 1,
        note: "The synchronous external Claude channel request path was removed. Use mailbox-backed channel steer or await reply."
      };
      base.importResponse(cwd, response);
      return { ...row, response };
    },
    auth,
    importResponse: base.importResponse
  };
}

module.exports = { create, findCli, findClaudeCli, sessionProcessAlive };
