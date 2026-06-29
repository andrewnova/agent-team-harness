const path = require("node:path");
const manual = require("./manual");
const {
  findCli,
  findClaudeCli,
  pluginRootFromCli
} = require("./claudeChannel/utils");
const {
  channelStatus,
  compactList,
  compactStatus,
  endpointFromStatus,
  findReachableProjectEndpoint,
  listTargets,
  renameTarget,
  runSmoke,
  waitForReachable,
  waitForStartedEndpoint,
  workspaceCwd,
  workspaceMismatch
} = require("./claudeChannel/status");
const {
  auth,
  authHelp,
  channelsFlagCheck,
  claudeAuthStatus,
  claudeVersion
} = require("./claudeChannel/auth");
const { installBridge } = require("./claudeChannel/install");
const {
  codexTerminalLauncher,
  defaultSessionName,
  launchBackground,
  launchCodexTerminal,
  launchPty,
  launchVisible
} = require("./claudeChannel/launcher");
const { sendChannelRequest } = require("./claudeChannel/request");
const { persistEnsure } = require("./claudeChannel/session");

function diagnose(cwd, options = {}) {
  const cli = findCli();
  const claude = findClaudeCli();
  const target = options.target || defaultSessionName(cwd);
  const issues = [];
  const cliCheck = {
    ok: cli.ok,
    path: cli.path,
    source: cli.source,
    reason: cli.reason
  };
  if (!cli.ok) issues.push(cli.reason);
  const claudeCheck = {
    ok: claude.ok,
    path: claude.path,
    reason: claude.reason
  };
  if (!claude.ok) issues.push(claude.reason);
  const version = claude.ok ? claudeVersion(claude, cwd) : null;
  const authStatus = claude.ok ? claudeAuthStatus(claude, cwd) : null;
  if (authStatus && !authStatus.ok) issues.push("Claude Code auth is not logged in or cannot be verified");
  const channels = cli.ok && claude.ok ? channelsFlagCheck(claude, cli, cwd) : null;
  if (channels && !channels.ok) issues.push("Claude Code did not accept the claude-channel receiver launch flags");
  const list = cli.ok ? listTargets(cli.command, cwd) : null;
  const status = cli.ok ? channelStatus(cli.command, target, cwd) : null;
  if (status && !status.ok) issues.push(`No healthy Claude channel endpoint resolved for target ${target}`);
  const smoke = options.smoke && cli.ok && status && status.ok ? runSmoke(cli.command, cwd, target, options.smoke_timeout_ms || 120000) : null;
  if (smoke && !smoke.ok) issues.push("Claude channel endpoint is healthy, but Claude did not complete the reply request");
  return {
    ok: issues.length === 0,
    checked_at: new Date().toISOString(),
    target,
    claude_channel_cli: cliCheck,
    claude_code: claudeCheck,
    claude_version: version,
    claude_auth: authStatus,
    auth_help: authStatus && !authStatus.ok ? authHelp(cwd, options) : null,
    channels_flag: channels,
    endpoint_list: compactList(list),
    endpoint_status: compactStatus(status),
    reply_ready: smoke ? smoke.ok : "unchecked",
    smoke,
    issues
  };
}

function ensure(cwd, options = {}) {
  const cli = findCli();
  if (!cli.ok) return persistEnsure(cwd, { ok: false, action: "missing_channel_cli", reason: cli.reason });
  const name = options.name || options.target || defaultSessionName(cwd);
  const target = options.target || name;
  const projectCwd = workspaceCwd(cwd, options);
  const baseRecord = {
    name,
    target,
    project_dir: projectCwd,
    harness_cwd: path.resolve(cwd)
  };
  const persist = (record) => persistEnsure(cwd, { ...baseRecord, ...record });
  const timeoutMs = options.timeout_ms || 45000;
  const pollMs = options.poll_ms || 1000;
  const initialStatus = channelStatus(cli.command, target, projectCwd);
  const initialMismatch = workspaceMismatch(endpointFromStatus(initialStatus), projectCwd);
  if (initialStatus.ok && !options.fresh_claude && (!initialMismatch || options.allow_cross_project_reuse)) {
    const smoke = options.smoke ? runSmoke(cli.command, projectCwd, target, options.smoke_timeout_ms || 120000) : null;
    return persist({
      ok: smoke ? smoke.ok : true,
      action: smoke && !smoke.ok ? "reused_smoke_failed" : "reused",
      endpoint: endpointFromStatus(initialStatus),
      workspace_mismatch: initialMismatch,
      cross_project_reuse_allowed: Boolean(initialMismatch && options.allow_cross_project_reuse),
      status: initialStatus,
      reply_ready: smoke ? smoke.ok : "unchecked",
      smoke
    });
  }
  const beforeList = listTargets(cli.command, projectCwd);
  const reusableProjectEndpoint = options.fresh_claude ? { ok: false, skipped: true, reason: "--fresh-claude" } : findReachableProjectEndpoint(cli.command, projectCwd, beforeList);
  if (reusableProjectEndpoint.ok && !options.fresh_claude) {
    let rename = null;
    if (reusableProjectEndpoint.endpoint.display_name !== name) {
      rename = renameTarget(cli.command, reusableProjectEndpoint.target, name, projectCwd);
      if (!rename.ok) {
        return persist({
          ok: false,
          action: "reuse_rename_failed",
          endpoint: reusableProjectEndpoint.endpoint,
          rename,
          initial_status: initialStatus,
          workspace_mismatch: initialMismatch,
          before_list: beforeList
        });
      }
    }
    const finalTarget = reusableProjectEndpoint.target;
    const finalStatus = waitForReachable(cli.command, finalTarget, projectCwd, timeoutMs, pollMs);
    const smoke = options.smoke && finalStatus && finalStatus.ok ? runSmoke(cli.command, projectCwd, finalTarget, options.smoke_timeout_ms || 120000) : null;
    return persist({
      ok: finalStatus && finalStatus.ok && (!smoke || smoke.ok),
      action:
        smoke && !smoke.ok
          ? rename
            ? "renamed_reused_smoke_failed"
            : "reused_project_endpoint_smoke_failed"
          : finalStatus && finalStatus.ok
            ? rename
              ? "renamed_reused"
              : "reused_project_endpoint"
            : "reused_unreachable",
      target: finalTarget,
      endpoint: reusableProjectEndpoint.endpoint,
      rename,
      initial_status: initialStatus,
      workspace_mismatch: initialMismatch,
      before_list: beforeList,
      status: finalStatus,
      reply_ready: smoke ? smoke.ok : "unchecked",
      smoke
    });
  }
  const claude = findClaudeCli();
  if (!claude.ok) {
    return persist({
      ok: false,
      action: "missing_claude_cli",
      reason: claude.reason,
      initial_status: initialStatus,
      workspace_mismatch: initialMismatch,
      skipped_reuse: reusableProjectEndpoint.skipped ? reusableProjectEndpoint : null
    });
  }
  const authStatus = claudeAuthStatus(claude, projectCwd);
  if (!authStatus.ok) {
    return persist({
      ok: false,
      action: "claude_auth_required",
      reason: "Claude Code auth is not logged in or cannot be verified",
      claude_path: claude.path,
      claude_auth: authStatus,
      auth_help: authHelp(projectCwd, options),
      initial_status: initialStatus,
      workspace_mismatch: initialMismatch,
      skipped_reuse: reusableProjectEndpoint.skipped ? reusableProjectEndpoint : null,
      before_list: beforeList
    });
  }
  const launchOptions = {
    ...options,
    harness_cwd: path.resolve(cwd),
    plugin_dir: options.plugin_dir || pluginRootFromCli(cli)
  };
  const launchMode = options.launch_mode || (codexTerminalLauncher(launchOptions) ? "codex-terminal" : "visible");
  if (!["codex-terminal", "visible", "pty", "background"].includes(launchMode)) {
    return persist({
      ok: false,
      action: "invalid_launch_mode",
      reason: "launch_mode must be codex-terminal, visible, pty, or background",
      initial_status: initialStatus,
      workspace_mismatch: initialMismatch
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
      start: started,
      background: started.background,
      initial_status: initialStatus,
      workspace_mismatch: initialMismatch,
      skipped_reuse: reusableProjectEndpoint.skipped ? reusableProjectEndpoint : null
    });
  }
  const discovered = waitForStartedEndpoint(cli.command, projectCwd, beforeList, timeoutMs, pollMs);
  let rename = null;
  let finalStatus = null;
  let endpoint = discovered.ok ? discovered.endpoint : null;
  let finalTarget = target;
  let recoveredEndpoint = null;
  if (discovered.ok) {
    if (endpoint.display_name !== name) {
      rename = renameTarget(cli.command, discovered.target, name, projectCwd);
      if (!rename.ok) {
        return persist({
          ok: false,
          action: "started_rename_failed",
          launch_mode: started.mode,
          claude_path: claude.path,
          channel_path: cli.path,
          start: started,
          background: started.background,
          endpoint,
          rename,
          initial_status: initialStatus,
          workspace_mismatch: initialMismatch,
          skipped_reuse: reusableProjectEndpoint.skipped ? reusableProjectEndpoint : null,
          before_list: beforeList,
          discovered
        });
      }
    }
    finalStatus = waitForReachable(cli.command, discovered.target, projectCwd, timeoutMs, pollMs);
    finalTarget = discovered.target;
  } else {
    recoveredEndpoint = findReachableProjectEndpoint(cli.command, projectCwd, listTargets(cli.command, projectCwd));
    if (recoveredEndpoint.ok) {
      finalTarget = recoveredEndpoint.target;
      finalStatus = recoveredEndpoint.status;
      endpoint = recoveredEndpoint.endpoint;
    } else {
      finalStatus = waitForReachable(cli.command, target, projectCwd, timeoutMs, pollMs);
      endpoint = endpointFromStatus(finalStatus);
    }
  }
  const finalMismatch = workspaceMismatch(endpoint, projectCwd);
  const smoke =
    options.smoke && finalStatus && finalStatus.ok && (!finalMismatch || options.allow_cross_project_reuse)
      ? runSmoke(cli.command, projectCwd, finalTarget, options.smoke_timeout_ms || 120000)
      : null;
  return persist({
    ok: finalStatus && finalStatus.ok && (!finalMismatch || options.allow_cross_project_reuse) && (!smoke || smoke.ok),
    action:
      finalMismatch && !options.allow_cross_project_reuse
        ? "workspace_mismatch"
        : smoke && !smoke.ok
          ? "started_smoke_failed"
          : finalStatus && finalStatus.ok
            ? recoveredEndpoint && recoveredEndpoint.ok
              ? "started_recovered_endpoint"
              : "started"
            : "started_unreachable",
    target: finalTarget,
    launch_mode: started.mode,
    claude_path: claude.path,
    channel_path: cli.path,
    start: started,
    background: started.background,
    endpoint,
    rename,
    initial_status: initialStatus,
    workspace_mismatch: finalMismatch || initialMismatch,
    cross_project_reuse_allowed: Boolean(finalMismatch && options.allow_cross_project_reuse),
    skipped_reuse: reusableProjectEndpoint.skipped ? reusableProjectEndpoint : null,
    before_list: beforeList,
    discovered,
    recovered_endpoint: recoveredEndpoint && recoveredEndpoint.ok ? recoveredEndpoint : null,
    status: finalStatus,
    command: started.command,
    reply_ready: smoke ? smoke.ok : "unchecked",
    smoke
  });
}

function create() {
  const base = manual.create();
  return {
    name: "claude-channel",
    status(target, cwd = process.cwd()) {
      const cli = findCli();
      if (!cli.ok) return cli;
      return { ...channelStatus(cli.command, target, cwd), path: cli.path, source: cli.source };
    },
    list(cwd = process.cwd()) {
      const cli = findCli();
      if (!cli.ok) return cli;
      return { ...listTargets(cli.command, cwd), path: cli.path, source: cli.source };
    },
    diagnose,
    install(cwd, options = {}) {
      return installBridge({ ...options, cwd });
    },
    ensure,
    request(cwd, request) {
      const cli = findCli();
      if (!cli.ok) {
        throw new Error(cli.reason);
      }
      const row = base.request(cwd, { ...request, adapter: "claude-channel", channel_command: cli.command });
      const response = sendChannelRequest(cwd, row, request, cli.command);
      base.importResponse(cwd, response);
      return { ...row, response };
    },
    auth,
    importResponse: base.importResponse
  };
}

module.exports = { create, findCli, findClaudeCli };
