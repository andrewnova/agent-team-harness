const fs = require("node:fs");
const path = require("node:path");
const { managedCliPath } = require("./install");

function executableCandidates(candidate) {
  if (process.platform !== "win32" || path.extname(candidate)) return [candidate];
  const pathExt = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return pathExt
    .split(";")
    .filter(Boolean)
    .map((extension) => `${candidate}${extension.toLowerCase()}`);
}

function findExecutable(file, command, source) {
  for (const candidate of executableCandidates(file)) {
    try {
      fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return {
        ok: true,
        command,
        path: candidate,
        source
      };
    } catch {
      // Keep scanning candidates.
    }
  }
  return null;
}

function findBinary(candidates, missingReason, source = "path") {
  const pathValue = process.env.PATH || "";
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) || candidate.includes(path.sep)) {
      const executable = findExecutable(candidate, candidate, source);
      if (executable) return executable;
      continue;
    }
    for (const dir of pathValue.split(path.delimiter)) {
      if (!dir) continue;
      const executable = findExecutable(path.join(dir, candidate), candidate, source);
      if (executable) return executable;
    }
  }
  return {
    ok: false,
    command: null,
    path: null,
    reason: missingReason
  };
}

function findCli() {
  if (process.env.AGENT_TEAM_CHANNEL_CLI) {
    const fromEnv = findBinary(
      [process.env.AGENT_TEAM_CHANNEL_CLI],
      "AGENT_TEAM_CHANNEL_CLI is set, but the file is not executable",
      "env"
    );
    if (fromEnv.ok) return fromEnv;
    return fromEnv;
  }
  const managed = findBinary([managedCliPath()], "Managed Claude channel bridge is not installed", "managed");
  if (managed.ok) return managed;
  return findBinary(
    ["claude-channel", "claude-channel-cli"],
    "Claude channel bridge is not installed; run agent-team channel install or scripts/install-codex.sh",
    "path"
  );
}

function findClaudeCli() {
  return findBinary(["claude"], "Claude Code CLI is not installed or not on PATH");
}

function findScriptCli() {
  return findBinary(["script"], "script(1) is not installed or not on PATH");
}

function findOsascript() {
  return findBinary(["osascript"], "osascript is not installed or not on PATH");
}

function pluginRootFromCli(cli) {
  try {
    let dir = path.dirname(fs.realpathSync(cli.path));
    while (dir && dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) return dir;
      dir = path.dirname(dir);
    }
  } catch {
    return null;
  }
  return null;
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function redactSensitiveDiagnostics(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveDiagnostics(item));
  if (value && typeof value === "object") {
    const redacted = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      redacted[childKey] = redactSensitiveDiagnostics(childValue, childKey);
    }
    return redacted;
  }
  if (typeof value !== "string") return value;
  if (/token|secret|password|credential|api[_-]?key/i.test(key)) return "[redacted]";
  return value
    .replace(/(?:[A-Za-z]:)?[^\s"'{}]*\.claude-channel\/token[^\s"'{}]*/g, "[redacted-token-path]")
    .replace(/[^\s"'{}]*secret-token[^\s"'{}]*/g, "[redacted-token]");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

module.exports = {
  findBinary,
  findCli,
  findClaudeCli,
  findScriptCli,
  findOsascript,
  pluginRootFromCli,
  parseJsonOutput,
  redactSensitiveDiagnostics,
  shellQuote,
  canonicalPath,
  sleepMs
};
