const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ensureDir } = require("../../fsutil");
const harnessPaths = require("../../paths");
const {
  findOsascript,
  findScriptCli,
  shellQuote
} = require("./utils");
const { MCP_SERVER_NAME } = require("../../mcp/claudeInstall");

const DEFAULT_TEAMMATE_QUICKSTART = [
  "# Claude Teammate Quickstart",
  "",
  "This is the short boot contract for a visible Claude Code teammate.",
  "",
  "## Source Of Truth",
  "",
  "- The durable mailbox is the communication truth.",
  "- Live Claude Channel is only a startup, health, smoke, or opportunistic delivery path.",
  "- Codex owns canonical task state, merge, proof, and final done.",
  "- Claude owns frontend/UI/UX execution and helps review backend clarity when asked.",
  "",
  "## Mailbox Replies",
  "",
  "For any Codex request, reply with the harness-side request id:",
  "",
  "```bash",
  "node /abs/path/to/agent-team/src/cli.js --cwd /abs/path/to/harness mailbox send \\",
  "  --from claude \\",
  "  --to codex \\",
  "  --kind reply \\",
  "  --request-id req_... \\",
  "  --in-reply-to msg_or_req_... \\",
  "  --task T-000001 \\",
  "  --subject \"ACK: received\" \\",
  "  --body \"ACK: received. I will do X next. Answer/blocker: ...\"",
  "```",
  "",
  "The daemon may send receipt_ack first. That only confirms inbox receipt. It is not the semantic answer, review verdict, check-in, or completion proof.",
  "",
  "## Long Work",
  "",
  "Send checkins during long tasks, especially while waiting on frontend subagents or browser proof.",
  "Use heartbeat for liveness, checkin for useful status, and reply for answers.",
  "",
  "## Batch Sends",
  "",
  "Use mailbox send-batch --json for multiple replies. Do not use shell loops, head parsing, relative cli.js calls from temp directories, or subshell variable tricks.",
  "",
  "## Browser Proof Feedback",
  "",
  "Codex browser proof writes browser-findings.json. Treat it as grounded evidence, fix the failures it names, and preserve Codex as proof owner.",
  "",
  "## Harness Improvements",
  "",
  "If the CLI, skill, plugin, mailbox, browser proof, or coordination workflow hiccups, keep the main task moving when safe and record a self-heal recommendation."
].join("\n");

function safeNameToken(value, max = 24) {
  return String(value || "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
}

function codexSessionIdentity(env = process.env) {
  const value = env.AGENT_TEAM_SESSION_ID || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || "";
  if (!value) return null;
  return {
    value,
    token: safeNameToken(value, 12),
    source: env.AGENT_TEAM_SESSION_ID ? "AGENT_TEAM_SESSION_ID" : env.CODEX_THREAD_ID ? "CODEX_THREAD_ID" : "CODEX_SESSION_ID"
  };
}

function defaultSessionName(cwd, env = process.env) {
  if (env.AGENT_TEAM_CLAUDE_NAME) return env.AGENT_TEAM_CLAUDE_NAME;
  const base = safeNameToken(path.basename(cwd), 32) || "project";
  const identity = codexSessionIdentity(env);
  return identity && identity.token ? `codex-${base}-${identity.token}` : `codex-${base}`;
}

function teammateQuickstartPath(harnessRoot) {
  return path.join(harnessRoot, ".agent-team", "teammate-quickstart.md");
}

function teammateQuickstartBlock(harnessRoot) {
  const file = teammateQuickstartPath(harnessRoot);
  if (!fs.existsSync(file)) {
    return [
      `Teammate quickstart file: ${file}`,
      "Quickstart file was not found; using the built-in boot contract:",
      "",
      DEFAULT_TEAMMATE_QUICKSTART
    ].join("\n");
  }
  const body = fs.readFileSync(file, "utf8").trim();
  return [
    `Teammate quickstart file: ${file}`,
    "",
    "Read this quickstart now. It is injected here so it is not missed:",
    "",
    body
  ].join("\n");
}

function defaultCliPath() {
  return path.resolve(__dirname, "..", "..", "cli.js");
}

function mcpServerScriptPath() {
  return path.resolve(__dirname, "..", "..", "mcp", "claudeServer.js");
}

function launchMcpServerName(launchId) {
  if (!launchId) return MCP_SERVER_NAME;
  const safeId = String(launchId).replace(/[^A-Za-z0-9-]+/g, "-").slice(0, 80);
  return `${MCP_SERVER_NAME}-${safeId}`;
}

function launchMcpConfig(name, cwd, options = {}) {
  if (options.use_first_party_mcp_channel === false || !options.launch_id) return null;
  if (options.launch_mcp_config) return options.launch_mcp_config;
  const harnessRoot = path.resolve(options.harness_cwd || options.harness_root || cwd);
  const env = channelEnv(name, cwd, options);
  const file = harnessPaths.channelLaunchMcpConfigPath(harnessRoot, options.launch_id);
  const serverName = launchMcpServerName(options.launch_id);
  const config = {
    mcpServers: {
      [serverName]: {
        type: "stdio",
        command: process.execPath,
        args: [mcpServerScriptPath(), "--cwd", harnessRoot],
        env: {
          AGENT_TEAM_SESSION_NAME: env.AGENT_TEAM_SESSION_NAME,
          AGENT_TEAM_PROJECT_DIR: env.AGENT_TEAM_PROJECT_DIR,
          AGENT_TEAM_HARNESS_CWD: env.AGENT_TEAM_HARNESS_CWD,
          AGENT_TEAM_LAUNCH_ID: env.AGENT_TEAM_LAUNCH_ID,
          AGENT_TEAM_CODEX_THREAD_ID: env.AGENT_TEAM_CODEX_THREAD_ID,
          AGENT_TEAM_MCP_SERVER_NAME: serverName,
          CLAUDE_CHANNEL_DISPLAY_NAME: env.CLAUDE_CHANNEL_DISPLAY_NAME,
          CLAUDE_CHANNEL_PROJECT_DIR: env.CLAUDE_CHANNEL_PROJECT_DIR
        }
      }
    }
  };
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  options.launch_mcp_config = {
    ok: true,
    path: file,
    relative_path: path.relative(harnessRoot, file),
    server_name: serverName
  };
  return options.launch_mcp_config;
}

function startupPrompt(name, cwd, options = {}) {
  const harnessRoot = path.resolve(options.harness_cwd || options.harness_root || cwd);
  const cliPath = path.resolve(options.cli_path || defaultCliPath());
  const cliCommand = `${shellQuote(process.execPath)} ${shellQuote(cliPath)} --cwd ${shellQuote(harnessRoot)}`;
  const bootAckCommand = options.launch_id
    ? `${cliCommand} channel boot-ack --launch-id ${shellQuote(options.launch_id)} --name ${shellQuote(name)} --project-dir ${shellQuote(cwd)}`
    : null;
  const quickstart = teammateQuickstartBlock(harnessRoot);
  return [
    `You are the Claude Code teammate for the Codex Agent Team Harness session named "${name}".`,
    `Project directory: ${cwd}`,
    `Harness root: ${harnessRoot}`,
    quickstart,
    bootAckCommand
      ? `On session start, run this exact durable boot ACK command once, then visibly say ACK Agent Team quickstart loaded; mailbox is truth: ${bootAckCommand}`
      : "On session start, visibly acknowledge: ACK Agent Team quickstart loaded; mailbox is truth.",
    "Stay visible and available as the Claude Code teammate for Codex.",
    "Own frontend UI, UX, layout, copy polish, visual QA, and large-context critique when asked.",
    "Help Codex on backend review, simplification, debugging, and re-grounding when asked.",
    "Use available browser observation tools when they are available and useful for frontend observation.",
    "Use the durable mailbox as your always-on lane to Codex. Send progress, blockers, steering, and replies even when no claude-channel request is pending.",
    "Real planning, implementation, review, refactor, and debugging work must flow through mailbox-backed harness state. Treat raw live-channel requests as health, smoke, or diagnostics only.",
    `Mailbox command shape: ${cliCommand} mailbox send --from claude --to codex --kind checkin --subject "Working" --body "Status/update" --task <task-id>.`,
    `For two or more replies, review verdicts, check-ins, or recommendations, write a JSON batch and run: ${cliCommand} mailbox send-batch --json <file>.`,
    "Do not hand-roll shell loops, relative cli.js calls, head parsing, or subshell variables for mailbox delivery from temporary job directories.",
    "For long tasks or Claude Agent Teams/subagent waits, send mailbox check-ins so Codex sees that you are active instead of blocked.",
    "For a durable reply to a Codex dispatch, use --kind reply --in-reply-to <harness-request-id>. Key replies to the harness request_id Codex created, not any MCP-side channel id.",
    "If Codex nudges after you already replied, send one concise pointer to the already-delivered mailbox message instead of redelivering the same payload through ad hoc scripts.",
    "If a CLI, skill, plugin, mailbox, review import, channel, or harness hiccup appears, record a self-heal recommendation or request-change and keep the main goal moving when safe.",
    "For explicit synchronous claude-channel requests, complete_channel_request is allowed when it is available, but still send important status or late replies through the mailbox.",
    "If the mailbox CLI is unavailable, write a Markdown notice for Codex.",
    "Preferred notice paths: docs/planning/claude-notice-<topic>.md or .agent-team/comms/codex-inbox/claude-notice-<topic>.md.",
    "Start notices with '# NOTICE for Codex', include task/goal IDs when known, and make them actionable."
  ].join("\n");
}

function startupUserPrompt(name, cwd, options = {}) {
  if (!options.launch_id) return null;
  const harnessRoot = path.resolve(options.harness_cwd || options.harness_root || cwd);
  const cliPath = path.resolve(options.cli_path || defaultCliPath());
  const cliCommand = `${shellQuote(process.execPath)} ${shellQuote(cliPath)} --cwd ${shellQuote(harnessRoot)}`;
  const bootAckCommand = `${cliCommand} channel boot-ack --launch-id ${shellQuote(options.launch_id)} --name ${shellQuote(name)} --project-dir ${shellQuote(cwd)}`;
  return [
    "Codex is starting this visible Claude teammate session now.",
    "",
    "First action: run this exact durable boot ACK command once using Bash:",
    "",
    "```bash",
    bootAckCommand,
    "```",
    "",
    "Then visibly say: ACK Agent Team quickstart loaded; mailbox is truth.",
    "Stay in this visible session for Codex steering after the ACK."
  ].join("\n");
}

function parseBackgroundOutput(stdout) {
  const text = stdout || "";
  const match = text.match(/backgrounded\s+[^A-Za-z0-9]+([A-Za-z0-9-]+)\s+[^A-Za-z0-9]+(.+)$/m);
  return {
    id: match ? match[1].trim() : null,
    name: match ? match[2].trim() : null,
    stdout: text.trim()
  };
}

function channelEnv(name, cwd, options = {}) {
  const harnessRoot = path.resolve(options.harness_cwd || options.harness_root || cwd);
  return {
    ...process.env,
    AGENT_TEAM_SESSION_NAME: name,
    AGENT_TEAM_PROJECT_DIR: cwd,
    AGENT_TEAM_HARNESS_CWD: harnessRoot,
    AGENT_TEAM_LAUNCH_ID: options.launch_id || "",
    AGENT_TEAM_CODEX_THREAD_ID:
      process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || process.env.AGENT_TEAM_SESSION_ID || "",
    CLAUDE_CHANNEL_DISPLAY_NAME: name,
    CLAUDE_CHANNEL_PROJECT_DIR: cwd
  };
}

function claudeSessionArgs(name, cwd, options, includeStartupPromptAsArg) {
  const args = [];
  if (options.plugin_dir) args.push("--plugin-dir", options.plugin_dir);
  const mcpConfig = launchMcpConfig(name, cwd, options);
  if (mcpConfig) args.push("--mcp-config", mcpConfig.path);
  const channelFlag = options.use_development_channel === true ? "--dangerously-load-development-channels" : "--channels";
  const channels = [];
  if (options.use_first_party_mcp_channel !== false) channels.push(`server:${mcpConfig ? mcpConfig.server_name : MCP_SERVER_NAME}`);
  channels.push("server:claude-channel-cli");
  for (const channel of channels) args.push(channelFlag, channel);
  if (options.chrome !== false) args.push("--chrome");
  args.push("--permission-mode", options.permission_mode || "auto");
  args.push("--effort", options.effort || "xhigh");
  args.push("--name", name);
  if (includeStartupPromptAsArg) {
    args.push(startupPrompt(name, cwd, options));
  } else {
    args.push("--append-system-prompt", startupPrompt(name, cwd, options));
  }
  return args;
}

function launchMarkerCommand(cwd, name, options = {}) {
  if (!options.launch_id) return null;
  const harnessRoot = path.resolve(options.harness_cwd || options.harness_root || cwd);
  const cliPath = path.resolve(options.cli_path || defaultCliPath());
  return [
    shellQuote(process.execPath),
    shellQuote(cliPath),
    "--cwd",
    shellQuote(harnessRoot),
    "channel",
    "launch-marker",
    "--launch-id",
    shellQuote(options.launch_id),
    "--name",
    shellQuote(name),
    "--project-dir",
    shellQuote(cwd),
    "--mode",
    shellQuote(options.launch_mode || "visible")
  ].join(" ");
}

function visibleShellCommand(claude, cwd, name, options) {
  const env = channelEnv(name, cwd, options);
  const envAssignments = [
    `AGENT_TEAM_SESSION_NAME=${shellQuote(env.AGENT_TEAM_SESSION_NAME)}`,
    `AGENT_TEAM_PROJECT_DIR=${shellQuote(env.AGENT_TEAM_PROJECT_DIR)}`,
    `AGENT_TEAM_HARNESS_CWD=${shellQuote(env.AGENT_TEAM_HARNESS_CWD)}`,
    `AGENT_TEAM_LAUNCH_ID=${shellQuote(env.AGENT_TEAM_LAUNCH_ID)}`,
    `AGENT_TEAM_CODEX_THREAD_ID=${shellQuote(env.AGENT_TEAM_CODEX_THREAD_ID)}`,
    `CLAUDE_CHANNEL_DISPLAY_NAME=${shellQuote(env.CLAUDE_CHANNEL_DISPLAY_NAME)}`,
    `CLAUDE_CHANNEL_PROJECT_DIR=${shellQuote(env.CLAUDE_CHANNEL_PROJECT_DIR)}`
  ];
  const args = claudeSessionArgs(name, cwd, options, false);
  const initialPrompt = startupUserPrompt(name, cwd, options);
  if (initialPrompt) args.push(initialPrompt);
  return [
    `cd ${shellQuote(cwd)}`,
    launchMarkerCommand(cwd, name, options),
    [...envAssignments, shellQuote(claude.path), ...args.map(shellQuote)].join(" ")
  ]
    .filter(Boolean)
    .join(" && ");
}

function launchCommand(command, name, cwd, options) {
  return {
    shell: command,
    channel_mode: options.use_development_channel === true ? "development" : "approved",
    mcp_config: options.launch_mcp_config || null,
    env: {
      AGENT_TEAM_LAUNCH_ID: options.launch_id || "",
      AGENT_TEAM_HARNESS_CWD: path.resolve(options.harness_cwd || options.harness_root || cwd),
      CLAUDE_CHANNEL_DISPLAY_NAME: name,
      CLAUDE_CHANNEL_PROJECT_DIR: cwd
    }
  };
}

function codexTerminalLauncher(options = {}) {
  return options.codex_terminal_launcher || process.env.AGENT_TEAM_CODEX_TERMINAL_LAUNCHER || null;
}

function launchVisible(claude, cwd, name, options) {
  const command = visibleShellCommand(claude, cwd, name, options);
  if (options.visible_launcher || process.env.AGENT_TEAM_VISIBLE_LAUNCHER) {
    const launcher = options.visible_launcher || process.env.AGENT_TEAM_VISIBLE_LAUNCHER;
    const result = spawnSync(launcher, [command], {
      cwd,
      encoding: "utf8",
      timeout: options.start_timeout_ms || 45000,
      env: channelEnv(name, cwd, options)
    });
    return {
      ok: result.status === 0 && !result.error,
      mode: "visible",
      launcher,
      exit_code: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      error: result.error ? result.error.message : undefined,
      command: launchCommand(command, name, cwd, options)
    };
  }
  const osascript = findOsascript();
  if (!osascript.ok) return { ok: false, mode: "visible", reason: osascript.reason, command: launchCommand(command, name, cwd, options) };
  const appName = options.visible_app || "Terminal";
  const script = [
    `tell application "${appName.replace(/"/g, '\\"')}"`,
    "activate",
    `do script ${JSON.stringify(command)}`,
    "end tell"
  ].join("\n");
  const result = spawnSync(osascript.command, ["-e", script], {
    cwd,
    encoding: "utf8",
    timeout: options.start_timeout_ms || 45000,
    env: channelEnv(name, cwd, options)
  });
  return {
    ok: result.status === 0 && !result.error,
    mode: "visible",
    app: appName,
    exit_code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error ? result.error.message : undefined,
    command: launchCommand(command, name, cwd, options)
  };
}

function launchCodexTerminal(claude, cwd, name, options) {
  const command = visibleShellCommand(claude, cwd, name, options);
  const launcher = codexTerminalLauncher(options);
  const commandDetails = launchCommand(command, name, cwd, options);
  if (!launcher) {
    return {
      ok: false,
      mode: "codex-terminal",
      reason: "codex_terminal_launcher_missing",
      instructions: [
        "Codex Desktop has a built-in Terminal pane, but this agent does not currently have a native API to open or write to that pane.",
        "Open a Codex Terminal pane for this thread and run command.shell there, or configure AGENT_TEAM_CODEX_TERMINAL_LAUNCHER to an executable that opens the command in Codex Terminal.",
        "Use --launch-mode visible for the external Terminal fallback."
      ],
      command: commandDetails
    };
  }
  const result = spawnSync(launcher, [command], {
    cwd,
    encoding: "utf8",
    timeout: options.start_timeout_ms || 45000,
    env: channelEnv(name, cwd, options)
  });
  return {
    ok: result.status === 0 && !result.error,
    mode: "codex-terminal",
    launcher,
    exit_code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error ? result.error.message : undefined,
    command: commandDetails
  };
}

function launchBackground(claude, cwd, name, options) {
  const args = ["--background", ...claudeSessionArgs(name, cwd, options, true)];
  const result = spawnSync(claude.command, args, {
    cwd,
    encoding: "utf8",
    timeout: options.start_timeout_ms || 45000,
    env: channelEnv(name, cwd, options)
  });
  return {
    ok: result.status === 0 && !result.error,
    mode: "background",
    exit_code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error ? result.error.message : undefined,
    background: parseBackgroundOutput(result.stdout),
    command: {
      bin: claude.command,
      args: args.slice(0, -1),
      channel_mode: options.use_development_channel === true ? "development" : "approved",
      env: {
        CLAUDE_CHANNEL_DISPLAY_NAME: name,
        CLAUDE_CHANNEL_PROJECT_DIR: cwd
      }
    }
  };
}

function launchPty(claude, cwd, name, options) {
  const scriptCli = findScriptCli();
  if (!scriptCli.ok) return { ok: false, mode: "pty", reason: scriptCli.reason };
  const logPath = harnessPaths.channelLaunchLogPath(cwd, name);
  ensureDir(path.dirname(logPath));
  const claudeArgs = claudeSessionArgs(name, cwd, options, false);
  const args = ["-q", "-F", logPath, claude.path, ...claudeArgs];
  try {
    const child = spawn(scriptCli.command, args, {
      cwd,
      detached: true,
      stdio: "ignore",
      env: channelEnv(name, cwd, options)
    });
    child.unref();
    return {
      ok: true,
      mode: "pty",
      pid: child.pid,
      log_path: logPath,
      background: {
        id: null,
        name,
        pid: child.pid,
        log_path: logPath
      },
      command: {
        bin: scriptCli.command,
        args: ["-q", "-F", logPath, claude.path, ...claudeArgs],
        channel_mode: options.use_development_channel === true ? "development" : "approved",
        env: {
          CLAUDE_CHANNEL_DISPLAY_NAME: name,
          CLAUDE_CHANNEL_PROJECT_DIR: cwd
        }
      }
    };
  } catch (error) {
    return {
      ok: false,
      mode: "pty",
      log_path: logPath,
      error: error.message
    };
  }
}

module.exports = {
  DEFAULT_TEAMMATE_QUICKSTART,
  defaultCliPath,
  defaultSessionName,
  codexSessionIdentity,
  launchMcpConfig,
  launchMcpServerName,
  startupPrompt,
  startupUserPrompt,
  teammateQuickstartPath,
  teammateQuickstartBlock,
  parseBackgroundOutput,
  channelEnv,
  claudeSessionArgs,
  codexTerminalLauncher,
  launchVisible,
  launchCodexTerminal,
  launchBackground,
  launchPty
};
