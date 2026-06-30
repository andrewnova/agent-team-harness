const path = require("node:path");

function rootDir(cwd) {
  return path.join(cwd, ".agent-team");
}

function stateDir(cwd) {
  return path.join(rootDir(cwd), "state");
}

function daemonDir(cwd) {
  return path.join(stateDir(cwd), "daemon");
}

function daemonPidPath(cwd) {
  return path.join(daemonDir(cwd), "daemon.json");
}

function daemonLogPath(cwd) {
  return path.join(daemonDir(cwd), "daemon.log");
}

function daemonErrorLogPath(cwd) {
  return path.join(daemonDir(cwd), "daemon.err.log");
}

function goalPath(cwd, goalId) {
  return path.join(stateDir(cwd), "goals", `${goalId}.json`);
}

function taskPath(cwd, taskId) {
  return path.join(stateDir(cwd), "tasks", `${taskId}.json`);
}

function runPath(cwd, runId) {
  return path.join(stateDir(cwd), "runs", `${runId}.json`);
}

function planDir(cwd, goalId) {
  return path.join(stateDir(cwd), "plans", goalId);
}

function planPath(cwd, goalId, author) {
  return path.join(planDir(cwd, goalId), `${author}.md`);
}

function planDecisionPath(cwd, goalId) {
  return path.join(planDir(cwd, goalId), "decision.json");
}

function attemptsPath(cwd, taskId) {
  return path.join(stateDir(cwd), "attempts", `${taskId}.jsonl`);
}

function eventsPath(cwd) {
  return path.join(stateDir(cwd), "events", "events.jsonl");
}

function reviewPath(cwd, taskId, reviewer) {
  return path.join(stateDir(cwd), "reviews", `${taskId}-${reviewer}.json`);
}

function proofPath(cwd, taskId) {
  return path.join(stateDir(cwd), "proof", taskId, "manifest.json");
}

function mergePath(cwd, taskId) {
  return path.join(stateDir(cwd), "merges", `${taskId}.json`);
}

function leasesPath(cwd) {
  return path.join(stateDir(cwd), "leases", "leases.json");
}

function dbPath(cwd) {
  return path.join(stateDir(cwd), "agent-team.sqlite");
}

function worktreesDir(cwd) {
  return path.join(rootDir(cwd), "worktrees");
}

function worktreePath(cwd, taskId) {
  return path.join(stateDir(cwd), "worktrees", `${taskId}.json`);
}

function advisoryPath(cwd, kind, id) {
  const safeKind = String(kind || "advisory").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  const safeId = String(id || Date.now()).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
  return path.join(stateDir(cwd), "advisory", safeKind, `${safeId}.json`);
}

function qualityPath(cwd, taskId) {
  return path.join(stateDir(cwd), "advisory", "quality", `${taskId}.json`);
}

function evidenceDir(cwd, taskId, runId) {
  return path.join(rootDir(cwd), "evidence", taskId, runId);
}

function approvalsPath(cwd) {
  return path.join(stateDir(cwd), "policies", "approvals.jsonl");
}

function regroundPath(cwd, taskId, sequence) {
  const suffix = String(sequence).padStart(4, "0");
  return path.join(stateDir(cwd), "regrounds", `${taskId}-${suffix}.json`);
}

function requestsPath(cwd) {
  return path.join(rootDir(cwd), "comms", "claude-channel", "requests.jsonl");
}

function responsesPath(cwd) {
  return path.join(rootDir(cwd), "comms", "claude-channel", "responses.jsonl");
}

function commsDir(cwd) {
  return path.join(rootDir(cwd), "comms");
}

function mailboxPath(cwd) {
  return path.join(commsDir(cwd), "mailbox.jsonl");
}

function mailboxAcksPath(cwd) {
  return path.join(commsDir(cwd), "acks.jsonl");
}

function mailboxBodiesDir(cwd) {
  return path.join(commsDir(cwd), "bodies");
}

function mailboxBodyPath(cwd, messageId) {
  const safeId = String(messageId || "message").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
  return path.join(mailboxBodiesDir(cwd), `${safeId}.md`);
}

function channelSessionPath(cwd) {
  return path.join(rootDir(cwd), "comms", "claude-channel", "session.json");
}

function channelSessionsPath(cwd) {
  return path.join(rootDir(cwd), "comms", "claude-channel", "sessions.jsonl");
}

function channelLaunchMarkersPath(cwd) {
  return path.join(rootDir(cwd), "comms", "claude-channel", "launch-markers.jsonl");
}

function channelBootAcksPath(cwd) {
  return path.join(rootDir(cwd), "comms", "claude-channel", "boot-acks.jsonl");
}

function channelMcpInitsPath(cwd) {
  return path.join(rootDir(cwd), "comms", "claude-channel", "mcp-inits.jsonl");
}

function channelMcpStartsPath(cwd) {
  return path.join(rootDir(cwd), "comms", "claude-channel", "mcp-starts.jsonl");
}

function channelStartupPacketsDir(cwd) {
  return path.join(rootDir(cwd), "comms", "claude-channel", "startup-packets");
}

function channelStartupPacketPath(cwd, launchId) {
  const safeId = String(launchId || "launch").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
  return path.join(channelStartupPacketsDir(cwd), `${safeId}.md`);
}

function channelLaunchMcpConfigDir(cwd) {
  return path.join(rootDir(cwd), "comms", "claude-channel", "mcp-configs");
}

function channelLaunchMcpConfigPath(cwd, launchId) {
  const safeId = String(launchId || "launch").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
  return path.join(channelLaunchMcpConfigDir(cwd), `${safeId}.json`);
}

function channelLaunchLogPath(cwd, name) {
  const safeName = String(name || "claude").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  return path.join(rootDir(cwd), "comms", "claude-channel", `${safeName}.log`);
}

function claudeMcpDir(cwd) {
  return path.join(commsDir(cwd), "claude-mcp");
}

function claudeMcpOutboxPath(cwd) {
  return path.join(claudeMcpDir(cwd), "outbox.jsonl");
}

function claudeMcpDeliveriesPath(cwd) {
  return path.join(claudeMcpDir(cwd), "deliveries.jsonl");
}

function codexMcpDir(cwd) {
  return path.join(commsDir(cwd), "codex-mcp");
}

function codexMcpManifestPath(cwd) {
  return path.join(codexMcpDir(cwd), "adapter.json");
}

function codexMcpReceiptsPath(cwd) {
  return path.join(codexMcpDir(cwd), "receipts.jsonl");
}

function codexWakeDir(cwd) {
  return path.join(commsDir(cwd), "codex-wake");
}

function codexWakeLogPath(cwd) {
  return path.join(codexWakeDir(cwd), "wake.jsonl");
}

function codexWakePayloadPath(cwd, messageId) {
  const safeId = String(messageId || "message").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
  return path.join(codexWakeDir(cwd), `wake-${safeId}.json`);
}

function boardPath(cwd) {
  return path.join(rootDir(cwd), "projections", "board.md");
}

function healthPath(cwd) {
  return path.join(rootDir(cwd), "projections", "health.md");
}

function taskProjectionPath(cwd, taskId) {
  return path.join(rootDir(cwd), "projections", "tasks", `${taskId}.md`);
}

function planProjectionPath(cwd, goalId) {
  return path.join(rootDir(cwd), "projections", "plans", `${goalId}.md`);
}

function reportsDir(cwd) {
  return path.join(rootDir(cwd), "reports");
}

function goalReportPath(cwd, goalId) {
  const safeGoal = String(goalId || "workspace").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  return path.join(reportsDir(cwd), safeGoal, "GOAL_REPORT.md");
}

function retentionDir(cwd) {
  return path.join(rootDir(cwd), "retention");
}

function retentionManifestPath(cwd) {
  return path.join(retentionDir(cwd), "retention-manifest.json");
}

function retentionPolicyPath(cwd) {
  return path.join(retentionDir(cwd), "RETENTION_POLICY.md");
}

module.exports = {
  rootDir,
  stateDir,
  daemonDir,
  daemonPidPath,
  daemonLogPath,
  daemonErrorLogPath,
  goalPath,
  taskPath,
  runPath,
  planDir,
  planPath,
  planDecisionPath,
  attemptsPath,
  eventsPath,
  reviewPath,
  proofPath,
  mergePath,
  leasesPath,
  dbPath,
  worktreesDir,
  worktreePath,
  advisoryPath,
  qualityPath,
  evidenceDir,
  approvalsPath,
  regroundPath,
  commsDir,
  mailboxPath,
  mailboxAcksPath,
  mailboxBodiesDir,
  mailboxBodyPath,
  requestsPath,
  responsesPath,
  channelSessionPath,
  channelSessionsPath,
  channelLaunchMarkersPath,
  channelBootAcksPath,
  channelMcpStartsPath,
  channelMcpInitsPath,
  channelStartupPacketsDir,
  channelStartupPacketPath,
  channelLaunchMcpConfigDir,
  channelLaunchMcpConfigPath,
  channelLaunchLogPath,
  claudeMcpDir,
  claudeMcpOutboxPath,
  claudeMcpDeliveriesPath,
  codexMcpDir,
  codexMcpManifestPath,
  codexMcpReceiptsPath,
  codexWakeDir,
  codexWakeLogPath,
  codexWakePayloadPath,
  boardPath,
  healthPath,
  taskProjectionPath,
  planProjectionPath,
  reportsDir,
  goalReportPath,
  retentionDir,
  retentionManifestPath,
  retentionPolicyPath
};
