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
  const deliveryReady = result.status === 0 && Boolean(parsed) && reachable && healthy;
  const presence = endpointPresence(parsed && parsed.endpoint);
  const healthErrorClass = healthErrorKind(parsed, result);
  const statusKindValue = statusKind(deliveryReady, parsed, presence, healthErrorClass);
  return {
    ok: deliveryReady,
    delivery_ready: deliveryReady,
    presence_ok: presence.loaded,
    presence,
    status_kind: statusKindValue,
    health_error_class: healthErrorClass,
    operator_hint: operatorHint(statusKindValue, presence, healthErrorClass),
    command: cliCommand,
    exit_code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    parsed,
    error: result.error ? result.error.message : undefined
  };
}

function endpointSeenSeconds(endpoint) {
  if (!endpoint || typeof endpoint !== "object") return null;
  if (Number.isFinite(endpoint.last_seen_seconds)) return endpoint.last_seen_seconds;
  if (!endpoint.last_seen_at) return null;
  const seen = Date.parse(endpoint.last_seen_at);
  if (!Number.isFinite(seen)) return null;
  return Math.max(0, Math.round((Date.now() - seen) / 1000));
}

function endpointPidAlive(endpoint) {
  if (!endpoint || typeof endpoint !== "object" || !Number.isInteger(endpoint.pid) || endpoint.pid <= 0) return null;
  try {
    process.kill(endpoint.pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM" ? true : false;
  }
}

function endpointPresence(endpoint) {
  const endpointPresent = Boolean(endpoint && typeof endpoint === "object");
  const lastSeenSeconds = endpointSeenSeconds(endpoint);
  const recent = lastSeenSeconds === null ? null : lastSeenSeconds <= 120;
  const pidAlive = endpointPidAlive(endpoint);
  const loaded = endpointPresent && pidAlive !== false && recent !== false;
  return {
    endpoint_present: endpointPresent,
    pid_alive: pidAlive,
    last_seen_seconds: lastSeenSeconds,
    recent,
    loaded
  };
}

function healthErrorKind(parsed, result) {
  const haystack = [
    result.stderr,
    result.stdout,
    parsed && parsed.health && parsed.health.error,
    parsed && parsed.error
  ]
    .filter(Boolean)
    .join("\n");
  if (/fetch failed/i.test(haystack)) return "fetch_failed";
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/i.test(haystack)) return "network_unreachable";
  if (parsed && parsed.health && parsed.health.ok === false) return "unhealthy";
  if (result.status !== 0) return "command_failed";
  return null;
}

function statusKind(deliveryReady, parsed, presence, healthErrorClass) {
  if (deliveryReady) return "delivery_ready";
  if (!parsed) return "invalid_or_empty_status";
  if (presence.loaded && healthErrorClass === "fetch_failed") return "loaded_fetch_failed";
  if (presence.loaded) return "loaded_channel_unverified";
  if (presence.endpoint_present) return "endpoint_registered_not_live";
  return "no_matching_endpoint";
}

function operatorHint(statusKindValue, presence, healthErrorClass) {
  if (statusKindValue === "loaded_fetch_failed" && presence && presence.loaded && healthErrorClass === "fetch_failed") {
    return {
      kind: "local_loopback_or_sandbox_blocked",
      confidence: "medium",
      reason:
        "A recent Claude endpoint is loaded, but the local health fetch failed. In Codex App or sandboxed shells, Claude auth files or localhost channel access may be hidden from the command.",
      next_step:
        "Rerun channel doctor/status/steer from a local process with Claude auth and localhost permissions before treating the endpoint as broken.",
      blocking_for_claiming_claude_working: true
    };
  }
  return null;
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

function waitForStartedEndpoint(cliCommand, cwd, beforeList, timeoutMs, pollMs, options = {}) {
  if (!beforeList || !beforeList.ok) {
    return { ok: false, reason: "list_unavailable", list: beforeList };
  }
  const beforeTargets = targetsFromList(beforeList);
  const beforeIds = new Set(beforeTargets.map(endpointTarget));
  const beforeProjectTargets = beforeTargets.filter((endpoint) => sameProject(endpoint, cwd));
  const deadline = Date.now() + timeoutMs;
  let latestList = beforeList;
  let latestStatus = null;
  let latestProbe = endpointLaunchProbe(cwd, beforeProjectTargets, beforeIds, latestList, [], [], null, options);
  do {
    latestList = listTargets(cliCommand, cwd);
    const projectTargets = targetsFromList(latestList).filter((endpoint) => sameProject(endpoint, cwd)).sort(newestFirst);
    const newTargets = projectTargets.filter((endpoint) => !beforeIds.has(endpointTarget(endpoint)));
    const existingProjectTargets = projectTargets.filter((endpoint) => beforeIds.has(endpointTarget(endpoint)));
    const reusableExistingTargets = options.display_name
      ? existingProjectTargets.filter((endpoint) => endpoint.display_name === options.display_name)
      : existingProjectTargets;
    const candidates = options.require_new
      ? newTargets
      : [...newTargets, ...reusableExistingTargets];
    const checked = [];
    latestProbe = endpointLaunchProbe(cwd, beforeProjectTargets, beforeIds, latestList, candidates, checked, null, options);
    for (const endpoint of candidates) {
      const target = endpointTarget(endpoint);
      if (!target) continue;
      latestStatus = channelStatus(cliCommand, target, cwd);
      checked.push(endpointProbeCheck(endpoint, beforeIds, latestStatus));
      latestProbe = endpointLaunchProbe(cwd, beforeProjectTargets, beforeIds, latestList, candidates, checked, null, options);
      if (latestStatus.ok || latestStatus.presence_ok) {
        const selected = { target, is_new: !beforeIds.has(target) };
        return {
          ok: true,
          endpoint,
          target,
          is_new: selected.is_new,
          status: latestStatus,
          list: latestList,
          probe: endpointLaunchProbe(cwd, beforeProjectTargets, beforeIds, latestList, candidates, checked, selected, options)
        };
      }
    }
    if (Date.now() >= deadline) break;
    sleepMs(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return {
    ok: false,
    reason: options.require_new ? "no_new_endpoint_after_fresh_launch" : "no_reachable_endpoint_after_launch",
    status: latestStatus,
    list: latestList,
    probe: latestProbe
  };
}

function endpointProbeTarget(endpoint, beforeIds) {
  const target = endpointTarget(endpoint);
  return {
    target,
    display_name: endpoint && endpoint.display_name ? endpoint.display_name : null,
    project_dir: endpoint && endpoint.project_dir ? endpoint.project_dir : null,
    is_new: beforeIds ? !beforeIds.has(target) : null,
    started_at: endpoint && endpoint.started_at ? endpoint.started_at : null,
    pid: endpoint && Number.isInteger(endpoint.pid) ? endpoint.pid : null,
    last_seen_seconds:
      endpoint && Number.isFinite(endpoint.last_seen_seconds) ? endpoint.last_seen_seconds : endpointSeenSeconds(endpoint)
  };
}

function endpointProbeCheck(endpoint, beforeIds, status) {
  return {
    ...endpointProbeTarget(endpoint, beforeIds),
    status_kind: status ? status.status_kind : null,
    delivery_ready: status ? status.delivery_ready : false,
    presence_ok: status ? status.presence_ok : false,
    health_error_class: status ? status.health_error_class : null
  };
}

function endpointLaunchProbe(cwd, beforeProjectTargets, beforeIds, latestList, candidates, checked, selected, options = {}) {
  const allTargets = targetsFromList(latestList);
  const projectTargets = allTargets.filter((endpoint) => sameProject(endpoint, cwd)).sort(newestFirst);
  const newProjectTargets = projectTargets.filter((endpoint) => !beforeIds.has(endpointTarget(endpoint)));
  const existingProjectTargets = projectTargets.filter((endpoint) => beforeIds.has(endpointTarget(endpoint)));
  const wrongProjectTargets = allTargets.filter((endpoint) => !sameProject(endpoint, cwd));
  return {
    require_new: Boolean(options.require_new),
    before_project_count: beforeProjectTargets.length,
    after_project_count: projectTargets.length,
    new_project_count: newProjectTargets.length,
    existing_project_count: existingProjectTargets.length,
    wrong_project_count: wrongProjectTargets.length,
    candidate_count: candidates.length,
    checked_count: checked.length,
    new_project_targets: newProjectTargets.slice(0, 8).map((endpoint) => endpointProbeTarget(endpoint, beforeIds)),
    existing_project_targets: existingProjectTargets.slice(0, 8).map((endpoint) => endpointProbeTarget(endpoint, beforeIds)),
    wrong_project_targets: wrongProjectTargets.slice(0, 4).map((endpoint) => endpointProbeTarget(endpoint, beforeIds)),
    candidates: candidates.slice(0, 8).map((endpoint) => endpointProbeTarget(endpoint, beforeIds)),
    checked: checked.slice(0, 8),
    selected_target: selected ? selected.target : null,
    selected_is_new: selected ? selected.is_new : null
  };
}

function findReachableProjectEndpoint(cliCommand, cwd, listResult, options = {}) {
  let projectTargets = targetsFromList(listResult).filter((endpoint) => sameProject(endpoint, cwd)).sort(newestFirst);
  if (options.display_name) projectTargets = projectTargets.filter((endpoint) => endpoint.display_name === options.display_name);
  for (const endpoint of projectTargets) {
    const target = endpointTarget(endpoint);
    if (!target) continue;
    const status = channelStatus(cliCommand, target, cwd);
    if (status.ok || status.presence_ok) return { ok: true, endpoint, target, status };
  }
  return { ok: false };
}

function findProjectEndpointByTarget(cliCommand, cwd, listResult, target) {
  if (!target) return { ok: false, reason: "remembered_endpoint_missing" };
  const endpoint = targetsFromList(listResult)
    .filter((candidate) => sameProject(candidate, cwd))
    .sort(newestFirst)
    .find((candidate) => endpointTarget(candidate) === target);
  if (!endpoint) return { ok: false, reason: "remembered_endpoint_not_listed", target };
  const status = channelStatus(cliCommand, target, cwd);
  if (status.ok || status.presence_ok) return { ok: true, endpoint, target, status };
  return { ok: false, reason: "remembered_endpoint_unreachable", endpoint, target, status };
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
    delivery_ready: status.delivery_ready,
    presence_ok: status.presence_ok,
    status_kind: status.status_kind,
    health_error_class: status.health_error_class,
    presence: status.presence,
    exit_code: status.exit_code,
    target: status.parsed ? status.parsed.target : undefined,
    endpoint: status.parsed ? compactTarget(status.parsed.endpoint) : null,
    reachable: status.parsed ? status.parsed.reachable : undefined,
    health: status.parsed ? status.parsed.health : undefined,
    operator_hint: status.operator_hint || undefined,
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
    list: compactList(discovered.list),
    probe: discovered.probe || null
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
  findProjectEndpointByTarget,
  findReachableProjectEndpoint,
  runSmoke,
  endpointFromStatus,
  compactTarget,
  compactList,
  compactStatus,
  compactDiscovered
};
