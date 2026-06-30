const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureDir, readJson, writeJson } = require("../fsutil");
const { defaultBinDir, writeWrapper, commandResult } = require("../bridge/claudeChannel/install");
const { findClaudeCli } = require("../bridge/claudeChannel/utils");

const MCP_SERVER_NAME = "agent-team-claude";
const MCP_WRAPPER_NAME = "agent-team-claude-mcp";

function serverScriptPath() {
  return path.resolve(__dirname, "claudeServer.js");
}

function defaultHomeDir() {
  return process.env.HOME || os.homedir();
}

function configPath(cwd, options = {}) {
  const scope = options.mcp_scope || "user";
  if (scope === "local") return path.join(path.resolve(options.project_dir || cwd), ".mcp.json");
  if (scope === "user") return path.join(path.resolve(options.home_dir || defaultHomeDir()), ".claude.json");
  throw new Error("--mcp-scope must be user or local");
}

function readConfig(file) {
  if (!fs.existsSync(file)) return {};
  const parsed = readJson(file);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function serverConfig(wrapperPath) {
  return {
    command: wrapperPath,
    args: []
  };
}

function sameServerConfig(actual, expected) {
  return Boolean(
    actual &&
      actual.command === expected.command &&
      JSON.stringify(actual.args || []) === JSON.stringify(expected.args || [])
  );
}

function writeMcpConfig(cwd, wrapperPath, options = {}) {
  const file = configPath(cwd, options);
  const config = readConfig(file);
  const expected = serverConfig(wrapperPath);
  config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  const previous = config.mcpServers[MCP_SERVER_NAME] || null;
  const alreadyConfigured = sameServerConfig(previous, expected);
  if (!alreadyConfigured) {
    config.mcpServers[MCP_SERVER_NAME] = expected;
    writeJson(file, config);
  }
  return {
    ok: true,
    scope: options.mcp_scope || "user",
    path: file,
    server_name: MCP_SERVER_NAME,
    created: !fs.existsSync(file) || !previous,
    updated: !alreadyConfigured,
    idempotent: alreadyConfigured,
    entry: expected
  };
}

function installClaudeMcp(cwd, options = {}) {
  const binDir = path.resolve(options.bin_dir || options.binDir || defaultBinDir());
  const wrapper = writeWrapper(binDir, MCP_WRAPPER_NAME, serverScriptPath());
  const verify = commandResult(wrapper.path, ["--help"], {
    cwd,
    timeout_ms: options.timeout_ms || 10000
  });
  const setupMcp = options.setup_mcp !== false;
  const setupMcpRequired = options.setup_mcp_required === true;
  const registration = setupMcp
    ? writeMcpConfig(cwd, wrapper.path, options)
    : {
        ok: false,
        skipped: true,
        reason: "--no-setup-mcp"
      };
  const setupOk = !setupMcp || registration.ok || !setupMcpRequired;
  return {
    ok: wrapper.ok && verify.ok && setupOk,
    ready: wrapper.ok && verify.ok && (!setupMcp || registration.ok),
    action: "installed",
    package: "agent-team-claude-mcp",
    server_name: MCP_SERVER_NAME,
    bin_dir: binDir,
    wrapper,
    server: {
      path: serverScriptPath()
    },
    verify,
    setup_mcp: registration,
    next_steps:
      setupMcp && registration.ok
        ? [
            `Start Claude Code with --dangerously-load-development-channels server:${MCP_SERVER_NAME} while channels are in preview.`,
            "Restart any already-open Claude Code teammate so it reloads MCP server configuration."
          ]
        : []
  };
}

function statusClaudeMcp(cwd, options = {}) {
  const binDir = path.resolve(options.bin_dir || options.binDir || defaultBinDir());
  const wrapperPath = path.join(binDir, MCP_WRAPPER_NAME);
  const wrapper_exists = fs.existsSync(wrapperPath);
  const file = configPath(cwd, options);
  const config = readConfig(file);
  const entry = config.mcpServers ? config.mcpServers[MCP_SERVER_NAME] : null;
  const expected = serverConfig(wrapperPath);
  const claude = findClaudeCli();
  return {
    ok: wrapper_exists && sameServerConfig(entry, expected),
    server_name: MCP_SERVER_NAME,
    scope: options.mcp_scope || "user",
    wrapper_path: wrapperPath,
    wrapper_exists,
    config_path: file,
    config_exists: fs.existsSync(file),
    configured: sameServerConfig(entry, expected),
    entry: entry || null,
    expected_entry: expected,
    claude_cli: claude
  };
}

module.exports = {
  MCP_SERVER_NAME,
  MCP_WRAPPER_NAME,
  configPath,
  installClaudeMcp,
  statusClaudeMcp
};
