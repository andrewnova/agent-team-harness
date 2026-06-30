const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_CHANNEL_CLI_VERSION = "0.3.0";

function defaultToolsDir() {
  return process.env.AGENT_TEAM_TOOLS_DIR || path.join(os.homedir(), ".local", "share", "agent-team");
}

function defaultBinDir() {
  return process.env.AGENT_TEAM_BIN_DIR || path.join(os.homedir(), ".local", "bin");
}

function managedPrefix(options = {}) {
  return path.resolve(options.tools_dir || options.toolsDir || defaultToolsDir(), "claude-channel-cli");
}

function managedBinDir(options = {}) {
  return path.join(managedPrefix(options), "node_modules", ".bin");
}

function executableName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function managedCliPath(options = {}) {
  return path.join(managedBinDir(options), executableName("claude-channel"));
}

function managedServerPath(options = {}) {
  return path.join(managedBinDir(options), executableName("claude-channel-server"));
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout_ms || 120000
  });
  return {
    ok: result.status === 0,
    command,
    args,
    exit_code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error ? result.error.message : undefined
  };
}

function writeWrapper(binDir, name, target) {
  fs.mkdirSync(binDir, { recursive: true });
  const wrapperPath = path.join(binDir, name);
  const body = ["#!/usr/bin/env bash", `exec ${shellQuote(target)} "$@"`, ""].join("\n");
  fs.writeFileSync(wrapperPath, body);
  fs.chmodSync(wrapperPath, 0o755);
  return {
    ok: true,
    name,
    path: wrapperPath,
    target
  };
}

function installBridge(options = {}) {
  const version = options.version || process.env.AGENT_TEAM_CHANNEL_VERSION || DEFAULT_CHANNEL_CLI_VERSION;
  const toolsDir = path.resolve(options.tools_dir || options.toolsDir || defaultToolsDir());
  const prefix = managedPrefix({ tools_dir: toolsDir });
  const binDir = path.resolve(options.bin_dir || options.binDir || defaultBinDir());
  const setupMcp = options.setup_mcp !== false;
  const setupMcpRequired = options.setup_mcp_required === true;
  const mcpScope = options.mcp_scope || "user";
  fs.mkdirSync(prefix, { recursive: true });

  const npmArgs = [
    "install",
    "--prefix",
    prefix,
    "--no-save",
    "--no-package-lock",
    "--omit=dev",
    `claude-channel-cli@${version}`
  ];
  const npm = commandResult("npm", npmArgs, {
    cwd: options.cwd || process.cwd(),
    timeout_ms: options.timeout_ms || 300000
  });

  const cliPath = managedCliPath({ tools_dir: toolsDir });
  const serverPath = managedServerPath({ tools_dir: toolsDir });
  const wrappers = [];
  let verify = {
    ok: false,
    command: cliPath,
    reason: "npm install did not complete"
  };
  let setup = {
    ok: false,
    skipped: true,
    reason: "--no-setup-mcp"
  };

  if (npm.ok) {
    wrappers.push(writeWrapper(binDir, "claude-channel", cliPath));
    if (fs.existsSync(serverPath)) wrappers.push(writeWrapper(binDir, "claude-channel-server", serverPath));
    verify = commandResult(cliPath, ["--version"], {
      cwd: options.cwd || process.cwd(),
      timeout_ms: 10000
    });
    if (setupMcp) {
      setup = commandResult(cliPath, ["setup-mcp", "--scope", mcpScope], {
        cwd: options.cwd || process.cwd(),
        timeout_ms: options.setup_timeout_ms || 60000
      });
      setup.skipped = false;
    }
  }

  const setupOk = !setupMcp || setup.ok || !setupMcpRequired;
  return {
    ok: npm.ok && verify.ok && setupOk,
    ready: npm.ok && verify.ok && (!setupMcp || setup.ok),
    action: npm.ok ? "installed" : "install_failed",
    package: "claude-channel-cli",
    version,
    tools_dir: toolsDir,
    prefix,
    bin_dir: binDir,
    claude_channel: {
      path: cliPath,
      server_path: fs.existsSync(serverPath) ? serverPath : null
    },
    npm,
    wrappers,
    verify,
    setup_mcp: setup,
    next_steps:
      setupMcp && !setup.ok
        ? [
            "Install or authenticate Claude Code, then rerun agent-team doctor --fix.",
            `Or run ${shellQuote(path.join(binDir, "claude-channel"))} setup-mcp --scope ${shellQuote(mcpScope)} after Claude Code is available.`
          ]
        : []
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

module.exports = {
  DEFAULT_CHANNEL_CLI_VERSION,
  defaultToolsDir,
  defaultBinDir,
  managedPrefix,
  managedBinDir,
  managedCliPath,
  managedServerPath,
  commandResult,
  writeWrapper,
  installBridge
};
