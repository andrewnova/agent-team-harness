const fs = require("node:fs");
const path = require("node:path");
const { ensureDir, readJson, writeJson } = require("../fsutil");
const { defaultBinDir, writeWrapper, commandResult } = require("../bridge/claudeChannel/install");
const paths = require("../paths");
const { MCP_SERVER_NAME, wakeRows } = require("./codexChannel");

const MCP_WRAPPER_NAME = "agent-team-codex-mcp";

function serverScriptPath() {
  return path.resolve(__dirname, "codexServer.js");
}

function serverConfig(wrapperPath) {
  return {
    type: "stdio",
    command: wrapperPath,
    args: [],
    env: {}
  };
}

function sameServerConfig(actual, expected) {
  return Boolean(
    actual &&
      actual.type === expected.type &&
      actual.command === expected.command &&
      JSON.stringify(actual.args || []) === JSON.stringify(expected.args || []) &&
      JSON.stringify(actual.env) === JSON.stringify(expected.env)
  );
}

function readManifest(file) {
  if (!fs.existsSync(file)) return null;
  const parsed = readJson(file);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function writeAdapterManifest(cwd, wrapperPath) {
  const file = paths.codexMcpManifestPath(cwd);
  const previous = readManifest(file);
  const expected = {
    server_name: MCP_SERVER_NAME,
    package: MCP_WRAPPER_NAME,
    config: serverConfig(wrapperPath),
    wake_stream_path: path.relative(cwd, paths.codexWakeLogPath(cwd)),
    receipts_path: path.relative(cwd, paths.codexMcpReceiptsPath(cwd)),
    mailbox_path: path.relative(cwd, paths.mailboxPath(cwd))
  };
  const alreadyConfigured =
    previous &&
    previous.server_name === expected.server_name &&
    sameServerConfig(previous.config, expected.config) &&
    previous.wake_stream_path === expected.wake_stream_path &&
    previous.receipts_path === expected.receipts_path &&
    previous.mailbox_path === expected.mailbox_path;
  if (!alreadyConfigured) {
    ensureDir(paths.codexMcpDir(cwd));
    writeJson(file, expected);
  }
  return {
    ok: true,
    path: file,
    created: !previous,
    updated: !alreadyConfigured,
    idempotent: Boolean(alreadyConfigured),
    entry: expected
  };
}

function installCodexMcp(cwd, options = {}) {
  const binDir = path.resolve(options.bin_dir || options.binDir || defaultBinDir());
  const wrapper = writeWrapper(binDir, MCP_WRAPPER_NAME, serverScriptPath());
  const verify = commandResult(wrapper.path, ["--help"], {
    cwd,
    timeout_ms: options.timeout_ms || 10000
  });
  const setupAdapter = options.setup_adapter !== false;
  const manifest = setupAdapter
    ? writeAdapterManifest(cwd, wrapper.path)
    : {
        ok: false,
        skipped: true,
        reason: "--no-setup-adapter"
      };
  return {
    ok: wrapper.ok && verify.ok && (!setupAdapter || manifest.ok),
    ready: wrapper.ok && verify.ok && (!setupAdapter || manifest.ok),
    action: "installed",
    package: MCP_WRAPPER_NAME,
    server_name: MCP_SERVER_NAME,
    bin_dir: binDir,
    wrapper,
    server: {
      path: serverScriptPath()
    },
    verify,
    adapter_manifest: manifest,
    next_steps: [
      "Register the stdio command with any Codex MCP surface that supports local MCP servers.",
      "Keep the receiver daemon running so Claude-to-Codex messages continue to append wake payloads."
    ]
  };
}

function statusCodexMcp(cwd, options = {}) {
  const binDir = path.resolve(options.bin_dir || options.binDir || defaultBinDir());
  const wrapperPath = path.join(binDir, MCP_WRAPPER_NAME);
  const wrapper_exists = fs.existsSync(wrapperPath);
  const manifestPath = paths.codexMcpManifestPath(cwd);
  const manifest = readManifest(manifestPath);
  const expected = serverConfig(wrapperPath);
  const configured = Boolean(manifest && manifest.server_name === MCP_SERVER_NAME && sameServerConfig(manifest.config, expected));
  return {
    ok: wrapper_exists && configured,
    server_name: MCP_SERVER_NAME,
    wrapper_path: wrapperPath,
    wrapper_exists,
    manifest_path: manifestPath,
    manifest_exists: fs.existsSync(manifestPath),
    configured,
    entry: manifest || null,
    expected_entry: {
      server_name: MCP_SERVER_NAME,
      package: MCP_WRAPPER_NAME,
      config: expected
    },
    wake_stream_path: path.relative(cwd, paths.codexWakeLogPath(cwd)),
    pending_wake_count: wakeRows(cwd, { limit: 100 }).length
  };
}

module.exports = {
  MCP_SERVER_NAME,
  MCP_WRAPPER_NAME,
  installCodexMcp,
  statusCodexMcp,
  writeAdapterManifest
};
