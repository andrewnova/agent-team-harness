const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { shellQuote, parseJsonOutput } = require("../bridge/claudeChannel/utils");

const APP_BINARY = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function string(value, name, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.includes("\0")) {
    throw new Error(`${name} must be ${allowEmpty ? "a" : "a nonempty"} string without NUL`);
  }
  return value;
}

function uuid(value, name) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${name} must be an explicit UUID; refs, indexes and current targets are forbidden`);
  }
  return value.toLowerCase();
}

function address(input) {
  return {
    workspace_id: uuid(input.workspace_id, "workspace_id"),
    surface_id: uuid(input.surface_id, "surface_id")
  };
}

// Runtime/model/MCP configuration belongs to the caller. No raw shell input and
// no default model, headless mode, or approval bypass is added here.
function buildShellCommand({ cwd, argv, env = {} } = {}) {
  string(cwd, "cwd");
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be absolute");
  if (!Array.isArray(argv) || !argv.length) throw new Error("argv must be a nonempty array");
  argv.forEach((arg, index) => string(arg, `argv[${index}]`, index > 0));
  if (argv[0].startsWith("-")) throw new Error("argv[0] cannot be an option");
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("env must be an object");
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.startsWith("CMUX_")) {
      throw new Error("env keys must be shell identifiers and cannot override CMUX_ session context");
    }
    return `${key}=${shellQuote(string(value, `env.${key}`, true))}`;
  });
  const launch = [...assignments, "exec", ...argv.map(shellQuote)].join(" ");
  // cmux uses the user's login shell. Select POSIX sh explicitly so launch
  // assignments and quoting do not depend on that shell's grammar.
  return `exec /bin/sh -c ${shellQuote(`cd ${shellQuote(cwd)} && ${launch}`)}`;
}

/**
 * Synchronous cmux CLI transport. run(bin, args, options) has spawnSync's result
 * shape. Only the coordinator should supply addresses, from persisted job data.
 * There is no process-local ownership registry: subsequent CLI invocations must
 * be able to operate the same durable session.
 *
 * Uses `cmux --json --id-format uuids rpc METHOD JSON`. Verified against cmux
 * v0.64.22 CLI/cmux.swift and Sources/TerminalController+WorkspaceCreate.swift:
 * rpc emits the result object; workspace.create supports initial_command and
 * returns workspace_id/surface_id. Legacy new-workspace suppresses JSON, and
 * send unescapes backslashes, so neither is a safe substitute.
 */
function createTransport({ cmux_bin, run = spawnSync } = {}) {
  const binary = cmux_bin === undefined ? (fs.existsSync(APP_BINARY) ? APP_BINARY : "cmux") : cmux_bin;
  string(binary, "cmux_bin");
  if (typeof run !== "function") throw new Error("run must be a synchronous command runner");

  function rpc(method, params) {
    const env = { ...process.env };
    for (const key of ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_TAB_ID", "CMUX_WINDOW_ID"]) delete env[key];
    let result;
    try {
      result = run(binary, ["--json", "--id-format", "uuids", "rpc", method, JSON.stringify(params)], {
        encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024, env, shell: false
      });
    } catch (cause) {
      throw new Error(`cmux ${method} command runner failed`, { cause });
    }
    if (!result || result.error || result.status !== 0) {
      // Never include argv: initial_command and text may contain private data.
      const detail = result?.error?.code || result?.signal || `exit ${result?.status ?? "unknown"}`;
      const error = new Error(`cmux ${method} failed (${detail})${result?.stderr ? `: ${String(result.stderr).trim()}` : ""}`);
      error.code = result?.error?.code || "CMUX_COMMAND_FAILED";
      throw error;
    }
    const payload = parseJsonOutput(result.stdout);
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.error || payload.ok === false) {
      throw new Error(`cmux ${method} returned an invalid JSON result`);
    }
    return payload;
  }

  function matchResponse(payload, target, surfaceRequired = true) {
    if (uuid(payload.workspace_id, "response workspace_id") !== target.workspace_id ||
        (surfaceRequired && uuid(payload.surface_id, "response surface_id") !== target.surface_id)) {
      throw new Error("cmux returned a different session address");
    }
  }

  function inspect(target) {
    const payload = rpc("surface.list", { workspace_id: target.workspace_id });
    matchResponse(payload, target, false);
    if (!Array.isArray(payload.surfaces)) throw new Error("cmux surface.list returned no surface inventory");
    const matches = payload.surfaces.filter((surface) => uuid(surface.id, "listed surface id") === target.surface_id);
    if (matches.length !== 1 || matches[0].type !== "terminal") {
      throw new Error("Addressed terminal does not belong to this workspace");
    }
    return payload.surfaces;
  }

  function createSession({ cwd, title, command } = {}) {
    string(title, "title");
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new Error("command must contain argv and optional env; raw shell commands are forbidden");
    }
    string(cwd, "cwd");
    if (!path.isAbsolute(cwd)) throw new Error("cwd must be absolute");
    const directory = fs.realpathSync.native(cwd);
    if (!fs.statSync(directory).isDirectory()) throw new Error("cwd must be an existing directory");
    const initial_command = buildShellCommand({ cwd: directory, argv: command.argv, env: command.env });
    let payload;
    try {
      payload = rpc("workspace.create", { cwd: directory, title, initial_command, focus: false, eager_load_terminal: true });
      const target = address(payload);
      return { ...target, status: "launching", ready: false };
    } catch (error) {
      // A timeout or lost/malformed response can follow a successful allocation.
      // Do not retry a launch, invent an address, or release a job's writer claim.
      error.launch_uncertain = true;
      if (payload && UUID.test(payload.workspace_id)) {
        error.session = { workspace_id: payload.workspace_id.toLowerCase() };
        if (UUID.test(payload.surface_id)) error.session.surface_id = payload.surface_id.toLowerCase();
      }
      throw error;
    }
  }

  function readSession(input = {}) {
    const target = address(input);
    inspect(target);
    const payload = rpc("surface.read_text", target);
    matchResponse(payload, target);
    return { ...target, text: string(payload.text, "response text", true) };
  }

  function sendText(input = {}) {
    const target = address(input);
    const text = string(input.text, "text", true);
    const submit = input.submit ?? false;
    if (typeof submit !== "boolean") throw new Error("submit must be a boolean");
    inspect(target);
    if (text.length) matchResponse(rpc("surface.send_text", { ...target, text }), target);
    if (submit) matchResponse(rpc("surface.send_key", { ...target, key: "enter" }), target);
    return { ...target, submitted: submit };
  }

  function closeSession(input = {}) {
    const target = address(input);
    // cmux refuses surface.close for the last surface. Each session owns one
    // workspace; refuse workspace.close if the user has since added any panels.
    if (inspect(target).length !== 1) throw new Error("Refusing to close a workspace containing other surfaces");
    const payload = rpc("workspace.close", { workspace_id: target.workspace_id });
    matchResponse(payload, target, false);
    // Closing the UI is not evidence that all descendant processes have stopped.
    return { ...target, status: "closed" };
  }

  return { createSession, readSession, sendText, closeSession };
}

module.exports = { createTransport, buildShellCommand };
