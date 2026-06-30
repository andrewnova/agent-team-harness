const fs = require("node:fs");
const path = require("node:path");
const { ensureDir, readJson, readJsonl, writeJson } = require("../fsutil");
const { defaultBinDir, writeWrapper, commandResult } = require("../bridge/claudeChannel/install");
const paths = require("../paths");
const { MCP_SERVER_NAME, wakeRows } = require("./codexChannel");

const MCP_WRAPPER_NAME = "agent-team-codex-mcp";
const MCP_WAKE_WRAPPER_NAME = "agent-team-codex-wake";

function serverScriptPath() {
  return path.resolve(__dirname, "codexServer.js");
}

function wakeCommandScriptPath() {
  return path.resolve(__dirname, "codexWakeCommand.js");
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

function writeAdapterManifest(cwd, wrapperPath, wakeCommandPath) {
  const file = paths.codexMcpManifestPath(cwd);
  const previous = readManifest(file);
  const expected = {
    server_name: MCP_SERVER_NAME,
    package: MCP_WRAPPER_NAME,
    config: serverConfig(wrapperPath),
    wake_command: wakeCommandPath,
    wake_stream_path: path.relative(cwd, paths.codexWakeLogPath(cwd)),
    receipts_path: path.relative(cwd, paths.codexMcpReceiptsPath(cwd)),
    wake_deliveries_path: path.join(path.relative(cwd, paths.codexMcpDir(cwd)), "wake-deliveries.jsonl"),
    mailbox_path: path.relative(cwd, paths.mailboxPath(cwd))
  };
  const alreadyConfigured =
    previous &&
    previous.server_name === expected.server_name &&
    sameServerConfig(previous.config, expected.config) &&
    previous.wake_command === expected.wake_command &&
    previous.wake_stream_path === expected.wake_stream_path &&
    previous.receipts_path === expected.receipts_path &&
    previous.wake_deliveries_path === expected.wake_deliveries_path &&
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
  const wakeWrapper = writeWrapper(binDir, MCP_WAKE_WRAPPER_NAME, wakeCommandScriptPath());
  const verify = commandResult(wrapper.path, ["--help"], {
    cwd,
    timeout_ms: options.timeout_ms || 10000
  });
  const wakeVerify = commandResult(wakeWrapper.path, ["--help"], {
    cwd,
    timeout_ms: options.timeout_ms || 10000
  });
  const setupAdapter = options.setup_adapter !== false;
  const manifest = setupAdapter
    ? writeAdapterManifest(cwd, wrapper.path, wakeWrapper.path)
    : {
        ok: false,
        skipped: true,
        reason: "--no-setup-adapter"
      };
  return {
    ok: wrapper.ok && wakeWrapper.ok && verify.ok && wakeVerify.ok && (!setupAdapter || manifest.ok),
    ready: wrapper.ok && wakeWrapper.ok && verify.ok && wakeVerify.ok && (!setupAdapter || manifest.ok),
    action: "installed",
    package: MCP_WRAPPER_NAME,
    server_name: MCP_SERVER_NAME,
    bin_dir: binDir,
    wrapper,
    wake_wrapper: wakeWrapper,
    server: {
      path: serverScriptPath()
    },
    wake_command: {
      path: wakeCommandScriptPath()
    },
    verify,
    wake_verify: wakeVerify,
    adapter_manifest: manifest,
    next_steps: [
      "Register the stdio command with any Codex MCP surface that supports local MCP servers.",
      "Keep the receiver daemon running so Claude-to-Codex messages invoke the local Codex wake command and append wake payloads."
    ]
  };
}

function statusCodexMcp(cwd, options = {}) {
  const binDir = path.resolve(options.bin_dir || options.binDir || defaultBinDir());
  const wrapperPath = path.join(binDir, MCP_WRAPPER_NAME);
  const wakeWrapperPath = path.join(binDir, MCP_WAKE_WRAPPER_NAME);
  const wrapper_exists = fs.existsSync(wrapperPath);
  const wake_command_exists = fs.existsSync(wakeWrapperPath);
  const manifestPath = paths.codexMcpManifestPath(cwd);
  const manifest = readManifest(manifestPath);
  const expected = serverConfig(wrapperPath);
  const wakes = wakeRows(cwd, { limit: 100 });
  const seenMessageIds = new Set(readJsonl(paths.codexMcpReceiptsPath(cwd)).map((row) => row.message_id).filter(Boolean));
  const pendingWakeCount = wakes.filter((row) => !seenMessageIds.has(row.message_id)).length;
  const configured = Boolean(
    manifest &&
      manifest.server_name === MCP_SERVER_NAME &&
      sameServerConfig(manifest.config, expected) &&
      manifest.wake_command === wakeWrapperPath
  );
  return {
    ok: wrapper_exists && wake_command_exists && configured,
    server_name: MCP_SERVER_NAME,
    wrapper_path: wrapperPath,
    wrapper_exists,
    wake_command_path: wakeWrapperPath,
    wake_command_exists,
    manifest_path: manifestPath,
    manifest_exists: fs.existsSync(manifestPath),
    configured,
    entry: manifest || null,
    expected_entry: {
      server_name: MCP_SERVER_NAME,
      package: MCP_WRAPPER_NAME,
      config: expected,
      wake_command: wakeWrapperPath
    },
    wake_stream_path: path.relative(cwd, paths.codexWakeLogPath(cwd)),
    total_wake_count: wakes.length,
    seen_wake_count: wakes.length - pendingWakeCount,
    pending_wake_count: pendingWakeCount
  };
}

module.exports = {
  MCP_SERVER_NAME,
  MCP_WRAPPER_NAME,
  MCP_WAKE_WRAPPER_NAME,
  installCodexMcp,
  statusCodexMcp,
  writeAdapterManifest
};
