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

function directory(cwd) {
  string(cwd, "cwd");
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be absolute");
  const canonical = fs.realpathSync.native(cwd);
  if (!fs.statSync(canonical).isDirectory()) throw new Error("cwd must be an existing directory");
  return canonical;
}

// Runtime/model/MCP configuration belongs to the caller. No raw shell input and
// no default model, headless mode, or approval bypass is added here.
function buildShellCommand({ cwd, argv, env = {}, exec_prefix = true } = {}) {
  string(cwd, "cwd");
  if (typeof exec_prefix !== "boolean") throw new Error("exec_prefix must be a boolean");
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
  // Select POSIX sh so assignments and quoting do not depend on the user's
  // shell. workspace.create wraps shell text in a login shell; surface.create
  // passes it straight to Ghostty, whose `exec -l` requires an executable first.
  return `${exec_prefix ? "exec " : ""}/bin/sh -c ${shellQuote(`cd ${shellQuote(cwd)} && ${launch}`)}`;
}

/**
 * Synchronous cmux CLI transport. run(bin, args, options) has spawnSync's result
 * shape. Only the coordinator should supply addresses, from persisted job data.
 * There is no process-local ownership registry: subsequent CLI invocations must
 * be able to operate the same durable session.
 *
 * Uses `cmux --json --id-format uuids rpc METHOD JSON`. Verified against cmux
 * v0.64.22 (installed commit ddd4a01bc), CLI/cmux.swift and the surface
 * coordinator in Packages/macOS/CmuxControlSocket/Sources/CmuxControlSocket:
 * workspace.create uses cwd; surface.create uses working_directory + pane_id.
 * Surface creation uses Workspace.newTerminalSurfaceOutcome's .immediate spawn
 * policy; TerminalSurface.swift schedules a hidden bootstrap runtime whenever
 * initial_command is present. eager_load_terminal is ONLY a workspace.create
 * option. Tab titles use tab.action rename. Legacy new-workspace suppresses JSON,
 * and send unescapes backslashes, so neither is a safe substitute.
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

  function listSurfaces(workspace_id) {
    const payload = rpc("surface.list", { workspace_id });
    matchResponse(payload, { workspace_id }, false);
    if (!Array.isArray(payload.surfaces)) throw new Error("cmux surface.list returned no surface inventory");
    const seen = new Set();
    return payload.surfaces.map((surface) => {
      const id = uuid(surface?.id, "listed surface id");
      if (seen.has(id)) throw new Error("cmux surface.list returned duplicate surface IDs");
      seen.add(id);
      return { ...surface, id };
    });
  }

  function terminal(surfaces, surface_id) {
    const matches = surfaces.filter((surface) => surface.id === surface_id);
    if (matches.length !== 1 || matches[0].type !== "terminal") {
      const error = new Error("Addressed terminal does not belong to this workspace");
      // Only a validated inventory proves absence. Connection failures, wrong
      // workspace responses and a changed surface type must never trigger repair.
      if (!matches.length) error.code = "CMUX_SURFACE_NOT_FOUND";
      throw error;
    }
    return matches[0];
  }

  function inspect(target) {
    const surfaces = listSurfaces(target.workspace_id);
    terminal(surfaces, target.surface_id);
    return surfaces;
  }

  function creationAddress(payload) {
    const target = address(payload);
    if (payload.pane_id != null) target.pane_id = uuid(payload.pane_id, "response pane_id");
    return target;
  }

  function uncertain(error, payload, workspace_id, surfaces = []) {
    // An allocation or rename may succeed before its response is lost. Preserve
    // the writer claim and any safe recovery address; never retry or auto-close.
    error.launch_uncertain = true;
    const returnedWorkspace = typeof payload?.workspace_id === "string" && UUID.test(payload.workspace_id)
      ? payload.workspace_id.toLowerCase() : undefined;
    const knownWorkspace = workspace_id ?? returnedWorkspace;
    if (knownWorkspace) {
      error.session = { workspace_id: knownWorkspace };
      if (returnedWorkspace === knownWorkspace && typeof payload?.surface_id === "string" && UUID.test(payload.surface_id)) {
        const surface_id = payload.surface_id.toLowerCase();
        // An echoed controller/other existing tab is not a newly launched job.
        if (!surfaces.some((surface) => surface.id === surface_id)) {
          error.session.surface_id = surface_id;
          if (typeof payload.pane_id === "string" && UUID.test(payload.pane_id)) {
            error.session.pane_id = payload.pane_id.toLowerCase();
          }
        }
      }
    }
    return error;
  }

  function createProject({ cwd, title } = {}) {
    string(title, "title");
    const canonical = directory(cwd);
    let payload;
    try {
      // A neutral initial shell keeps the project alive as job tabs come/go.
      payload = rpc("workspace.create", { cwd: canonical, title, focus: false, eager_load_terminal: true });
      return creationAddress(payload);
    } catch (error) {
      throw uncertain(error, payload);
    }
  }

  function createSession({ workspace_id, anchor_surface_id, pane_id, cwd, title, command } = {}) {
    string(title, "title");
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new Error("command must contain argv and optional env; raw shell commands are forbidden");
    }
    const canonical = directory(cwd);
    const initial_command = buildShellCommand({
      cwd: canonical, argv: command.argv, env: command.env, exec_prefix: workspace_id === undefined
    });
    if (workspace_id === undefined && (anchor_surface_id !== undefined || pane_id !== undefined)) {
      throw new Error("workspace_id is required with anchor_surface_id or pane_id");
    }
    let surfaces = [];
    if (workspace_id !== undefined) {
      workspace_id = uuid(workspace_id, "workspace_id");
      if (anchor_surface_id !== undefined) anchor_surface_id = uuid(anchor_surface_id, "anchor_surface_id");
      if (pane_id !== undefined) pane_id = uuid(pane_id, "pane_id");
      // Resolve against the persisted project, never the user's selected pane,
      // a list index, a title, or the caller's CMUX_* defaults.
      surfaces = listSurfaces(workspace_id);
      const workspaceSurfaces = surfaces.filter((surface) => surface.dock_scope == null);
      if (anchor_surface_id !== undefined) {
        const anchor = terminal(workspaceSurfaces, anchor_surface_id);
        const anchorPane = uuid(anchor.pane_id, "anchor pane_id");
        if (pane_id !== undefined && pane_id !== anchorPane) throw new Error("pane_id does not match the anchor's pane");
        pane_id = anchorPane;
      } else {
        const panes = new Set(workspaceSurfaces.map((surface) => uuid(surface.pane_id, "listed pane_id")));
        if (pane_id !== undefined) {
          if (!panes.has(pane_id)) throw new Error("Addressed pane does not belong to this workspace");
        } else {
          if (panes.size !== 1) throw new Error("An anchor_surface_id or explicit pane_id is required for an ambiguous project pane");
          [pane_id] = panes;
        }
      }
    }
    let payload;
    try {
      if (workspace_id === undefined) {
        // Compatibility for callers that still intentionally allocate one
        // workspace per session. Native project launches always supply its UUID.
        payload = rpc("workspace.create", { cwd: canonical, title, initial_command, focus: false, eager_load_terminal: true });
        return { ...address(payload), status: "launching", ready: false };
      }
      payload = rpc("surface.create", {
        workspace_id, pane_id, type: "terminal", working_directory: canonical, initial_command, focus: false
      });
      const target = creationAddress(payload);
      matchResponse(payload, { workspace_id }, false);
      if (target.pane_id !== pane_id) throw new Error("cmux returned a different or missing pane_id");
      if (surfaces.some((surface) => surface.id === target.surface_id)) throw new Error("cmux returned an existing surface instead of a new session");
      if (payload.type !== undefined && payload.type !== "terminal") throw new Error("cmux did not create a terminal");
      matchResponse(rpc("tab.action", { ...address(target), action: "rename", title, focus: false }), target);
      return { ...target, status: "launching", ready: false };
    } catch (error) {
      throw uncertain(error, payload, workspace_id, surfaces);
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
    // v0.64.22 also checks this inside surface.close, covering a concurrent
    // last-tab removal. Never fall back to closing the shared project workspace.
    if (inspect(target).length <= 1) throw new Error("Refusing to close the last surface; use closeProject explicitly");
    matchResponse(rpc("surface.close", target), target);
    // Closing the UI is not evidence that all descendant processes have stopped.
    return { ...target, status: "closed" };
  }

  function closeProject(input = {}) {
    const target = address(input);
    // Explicit project teardown (also supports legacy ungrouped sessions) only
    // after the controller is the sole surface. Never close other users' tabs.
    if (inspect(target).length !== 1) throw new Error("Refusing to close a workspace containing other surfaces");
    const payload = rpc("workspace.close", { workspace_id: target.workspace_id });
    matchResponse(payload, target, false);
    return { ...target, status: "closed" };
  }

  return { createProject, createSession, readSession, sendText, closeSession, closeProject };
}

module.exports = { createTransport, buildShellCommand };
