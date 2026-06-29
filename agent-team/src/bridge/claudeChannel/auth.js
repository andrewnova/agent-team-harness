const { spawnSync } = require("node:child_process");
const path = require("node:path");
const {
  findClaudeCli,
  parseJsonOutput,
  pluginRootFromCli,
  redactSensitiveDiagnostics,
  shellQuote
} = require("./utils");

function authLoginArgs(options = {}) {
  const args = ["auth", "login"];
  args.push(options.console ? "--console" : "--claudeai");
  if (options.email) args.push("--email", options.email);
  if (options.sso) args.push("--sso");
  return args;
}

function authHelp(cwd, options = {}) {
  const args = authLoginArgs(options);
  const harnessArgs = [process.execPath, path.join(__dirname, "..", "..", "cli.js"), "channel", "auth", "login"];
  harnessArgs.push(options.console ? "--console" : "--claudeai");
  if (options.email) harnessArgs.push("--email", options.email);
  if (options.sso) harnessArgs.push("--sso");
  return {
    action: "login_required",
    command: ["claude", ...args].map(shellQuote).join(" "),
    harness_command: harnessArgs.map(shellQuote).join(" "),
    note: "Run the harness command. Claude Code will open or print the Anthropic login flow; after it completes, rerun agent-team start.",
    cwd
  };
}

function claudeVersion(claude, cwd) {
  const result = spawnSync(claude.command, ["--version"], {
    cwd,
    encoding: "utf8",
    timeout: 5000
  });
  return {
    ok: result.status === 0,
    exit_code: result.status,
    version: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error ? result.error.message : undefined
  };
}

function claudeAuthStatus(claude, cwd) {
  const result = spawnSync(claude.command, ["auth", "status"], {
    cwd,
    encoding: "utf8",
    timeout: 10000
  });
  const parsed = parseJsonOutput(result.stdout.trim());
  return {
    ok: result.status === 0 && Boolean(parsed && parsed.loggedIn),
    exit_code: result.status,
    logged_in: Boolean(parsed && parsed.loggedIn),
    auth_method: parsed ? parsed.authMethod : undefined,
    api_provider: parsed ? parsed.apiProvider : undefined,
    subscription_type: parsed ? parsed.subscriptionType : undefined,
    stderr: result.stderr.trim(),
    error: result.error ? result.error.message : undefined
  };
}

function channelsFlagCheck(claude, cli, cwd) {
  const pluginRoot = cli.ok ? pluginRootFromCli(cli) : null;
  const baseArgs = [];
  if (pluginRoot) baseArgs.push("--plugin-dir", pluginRoot);
  const checks = [
    {
      mode: "development",
      args: [...baseArgs, "--dangerously-load-development-channels", "server:claude-channel-cli", "--version"]
    },
    {
      mode: "approved",
      args: [...baseArgs, "--channels", "server:claude-channel-cli", "--version"]
    }
  ];
  const results = checks.map((check) => {
    const result = spawnSync(claude.command, check.args, {
      cwd,
      encoding: "utf8",
      timeout: 10000
    });
    return {
      mode: check.mode,
      ok: result.status === 0,
      exit_code: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      error: result.error ? result.error.message : undefined
    };
  });
  const selected = results.find((result) => result.ok) || results[0];
  return {
    ok: Boolean(selected && selected.ok),
    mode: selected ? selected.mode : "unknown",
    exit_code: selected ? selected.exit_code : null,
    plugin_dir: pluginRoot,
    stdout: selected ? selected.stdout : "",
    stderr: selected ? selected.stderr : "",
    error: selected ? selected.error : undefined,
    checks: results
  };
}

function auth(cwd, options = {}) {
  const claude = findClaudeCli();
  if (!claude.ok) {
    return {
      ok: false,
      action: "missing_claude_cli",
      reason: claude.reason
    };
  }
  const before = claudeAuthStatus(claude, cwd);
  if (!options.login) {
    return {
      ok: before.ok,
      action: before.ok ? "already_authenticated" : "claude_auth_required",
      claude_path: claude.path,
      claude_auth: before,
      auth_help: before.ok ? null : authHelp(cwd, options)
    };
  }
  const args = authLoginArgs(options);
  const result = spawnSync(claude.command, args, {
    cwd,
    encoding: "utf8",
    timeout: options.timeout_ms || 300000
  });
  const after = claudeAuthStatus(claude, cwd);
  return redactSensitiveDiagnostics({
    ok: after.ok,
    action: after.ok ? "authenticated" : "login_incomplete",
    claude_path: claude.path,
    command: ["claude", ...args].map(shellQuote).join(" "),
    exit_code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error ? result.error.message : undefined,
    claude_auth_before: before,
    claude_auth: after,
    auth_help: after.ok ? null : authHelp(cwd, options)
  });
}

module.exports = {
  auth,
  authHelp,
  authLoginArgs,
  channelsFlagCheck,
  claudeAuthStatus,
  claudeVersion
};
