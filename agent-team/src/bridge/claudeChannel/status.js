const { spawnSync } = require("node:child_process");
const {
  canonicalPath,
  parseJsonOutput,
  sleepMs
} = require("./utils");

function channelStatus(cliCommand, target, cwd) {
  const args = ["status"];
  if (target) args.push("--to", target);
  const result = spawnSync(cliCommand, args, { cwd, encoding: "utf8", timeout: 5000 });
  const parsed = parseJsonOutput(result.stdout.trim());
  const reachable = parsed ? parsed.reachable !== false : false;
  const healthy = parsed ? !(parsed.health && parsed.health.ok === false) : false;
  return {
    ok: result.status === 0 && Boolean(parsed) && reachable && healthy,
    command: cliCommand,
    exit_code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    parsed,
    error: result.error ? result.error.message : undefined
  };
}

function listTargets(cliCommand, cwd) {
  const result = spawnSync(cliCommand, ["list", "--json"], { cwd, encoding: "utf8", timeout: 5000 });
  return {
    ok: result.status === 0,
    command: cliCommand,
    exit_code: result.status,
    targets: parseJsonOutput(result.stdout.trim()) || null,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error ? result.error.message : undefined
  };
}

function targetsFromList(listResult) {
  return (listResult && listResult.targets && Array.isArray(listResult.targets.targets) ? listResult.targets.targets : []).filter(Boolean);
}

function endpointTarget(endpoint) {
  return endpoint && (endpoint.target || endpoint.endpoint_id);
}

function sameProject(endpoint, cwd) {
  if (!endpoint || !endpoint.project_dir) return false;
  return canonicalPath(endpoint.project_dir) === canonicalPath(cwd);
}

function workspaceCwd(cwd, options = {}) {
  return canonicalPath(require("node:path").resolve(cwd, options.project_dir || "."));
}

function workspaceMismatch(endpoint, projectCwd) {
  if (!endpoint || !endpoint.project_dir) return null;
  if (sameProject(endpoint, projectCwd)) return null;
  return {
    expected_project_dir: canonicalPath(projectCwd),
    actual_project_dir: canonicalPath(endpoint.project_dir),
    target: endpointTarget(endpoint),
    display_name: endpoint.display_name || null,
    reason: "Claude channel endpoint is reachable, but it belongs to a different workspace"
  };
}

function newestFirst(a, b) {
  return Date.parse(b.started_at || 0) - Date.parse(a.started_at || 0);
}

function renameTarget(cliCommand, target, displayName, cwd) {
  const result = spawnSync(cliCommand, ["rename", "--to", target, displayName], {
    cwd,
    encoding: "utf8",
    timeout: 10000
  });
  return {
    ok: result.status === 0,
    command: cliCommand,
    exit_code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error ? result.error.message : undefined
  };
}

function waitForReachable(cliCommand, target, cwd, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  do {
    latest = channelStatus(cliCommand, target, cwd);
    if (latest.ok) return latest;
    if (Date.now() >= deadline) break;
    sleepMs(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return latest;
}

function waitForStartedEndpoint(cliCommand, cwd, beforeList, timeoutMs, pollMs) {
  if (!beforeList || !beforeList.ok) {
    return { ok: false, reason: "list_unavailable", list: beforeList };
  }
  const beforeIds = new Set(targetsFromList(beforeList).map(endpointTarget));
  const deadline = Date.now() + timeoutMs;
  let latestList = beforeList;
  let latestStatus = null;
  do {
    latestList = listTargets(cliCommand, cwd);
    const projectTargets = targetsFromList(latestList).filter((endpoint) => sameProject(endpoint, cwd)).sort(newestFirst);
    const newTargets = projectTargets.filter((endpoint) => !beforeIds.has(endpointTarget(endpoint)));
    const candidates = [...newTargets, ...projectTargets.filter((endpoint) => beforeIds.has(endpointTarget(endpoint)))];
    for (const endpoint of candidates) {
      const target = endpointTarget(endpoint);
      if (!target) continue;
      latestStatus = channelStatus(cliCommand, target, cwd);
      if (latestStatus.ok) {
        return {
          ok: true,
          endpoint,
          target,
          is_new: !beforeIds.has(target),
          status: latestStatus,
          list: latestList
        };
      }
    }
    if (Date.now() >= deadline) break;
    sleepMs(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { ok: false, status: latestStatus, list: latestList };
}

function findReachableProjectEndpoint(cliCommand, cwd, listResult) {
  const projectTargets = targetsFromList(listResult).filter((endpoint) => sameProject(endpoint, cwd)).sort(newestFirst);
  for (const endpoint of projectTargets) {
    const target = endpointTarget(endpoint);
    if (!target) continue;
    const status = channelStatus(cliCommand, target, cwd);
    if (status.ok) return { ok: true, endpoint, target, status };
  }
  return { ok: false };
}

function runSmoke(cliCommand, cwd, target, timeoutMs) {
  const expected = `agent-team-ready-${Date.now()}`;
  const prompt = `From Codex: channel readiness smoke test. Reply through complete_channel_request with exact text: ${expected}`;
  const result = spawnSync(
    cliCommand,
    ["ask", "--to", target, "--output", "json", "--timeout-ms", String(timeoutMs), "--no-progress", prompt],
    {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs + 5000
    }
  );
  const parsed = parseJsonOutput(result.stdout.trim());
  const answer = parsed && typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  return {
    ok: result.status === 0 && answer === expected,
    expected,
    answer,
    exit_code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    parsed,
    error: result.error ? result.error.message : undefined
  };
}

function endpointFromStatus(status) {
  if (!status || !status.parsed) return null;
  return status.parsed.endpoint || status.parsed.target || null;
}

function compactTarget(endpoint) {
  if (!endpoint) return null;
  return {
    target: endpointTarget(endpoint),
    display_name: endpoint.display_name,
    project_dir: endpoint.project_dir,
    pid: endpoint.pid,
    last_seen_seconds: endpoint.last_seen_seconds
  };
}

function compactList(list) {
  if (!list) return null;
  return {
    ok: list.ok,
    exit_code: list.exit_code,
    targets: targetsFromList(list).map(compactTarget),
    stderr: list.stderr,
    error: list.error
  };
}

function compactStatus(status) {
  if (!status) return null;
  return {
    ok: status.ok,
    exit_code: status.exit_code,
    target: status.parsed ? status.parsed.target : undefined,
    endpoint: status.parsed ? compactTarget(status.parsed.endpoint) : null,
    reachable: status.parsed ? status.parsed.reachable : undefined,
    health: status.parsed ? status.parsed.health : undefined,
    stderr: status.stderr,
    error: status.error
  };
}

function compactDiscovered(discovered) {
  if (!discovered) return null;
  return {
    ok: discovered.ok,
    reason: discovered.reason,
    target: discovered.target,
    is_new: discovered.is_new,
    endpoint: compactTarget(discovered.endpoint),
    status: compactStatus(discovered.status),
    list: compactList(discovered.list)
  };
}

module.exports = {
  channelStatus,
  listTargets,
  targetsFromList,
  endpointTarget,
  sameProject,
  workspaceCwd,
  workspaceMismatch,
  renameTarget,
  waitForReachable,
  waitForStartedEndpoint,
  findReachableProjectEndpoint,
  runSmoke,
  endpointFromStatus,
  compactTarget,
  compactList,
  compactStatus,
  compactDiscovered
};
