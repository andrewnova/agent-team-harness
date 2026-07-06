const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function defaultBinDir() {
  return process.env.AGENT_TEAM_BIN_DIR || path.join(os.homedir(), ".local", "bin");
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
  const command = target.endsWith(".js")
    ? `${shellQuote(process.execPath)} ${shellQuote(target)}`
    : shellQuote(target);
  const body = ["#!/usr/bin/env bash", `exec ${command} "$@"`, ""].join("\n");
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
  return {
    ok: false,
    ready: false,
    action: "removed",
    package: "first-party-agent-team-mcp",
    reason:
      "The external Claude channel package was removed from the Agent Team Harness. Use channel mcp install/start/channel steer with the first-party Claude MCP server.",
    bin_dir: path.resolve(options.bin_dir || options.binDir || defaultBinDir())
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

module.exports = {
  defaultBinDir,
  commandResult,
  writeWrapper,
  installBridge
};
