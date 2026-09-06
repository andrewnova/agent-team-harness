const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const jobs = require("./jobs");
const { createTransport } = require("./cmux");
const config = require("../../native-team.config.json");
const { readTools } = require("./claudeAgentGuard");

function attemptDirectory(root, job) {
  const dir = path.join(fs.realpathSync(root), ".agent-team", "sessions", job.id, String(job.attempt));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(dir) !== dir) throw new Error("session directory must not be aliased");
  return dir;
}

function buildNativeCommand(root, job, options = {}) {
  const directory = attemptDirectory(root, job);
  const server = path.join(__dirname, "sessionMcp.js");
  const serverArgs = [server, "--cwd", root, "--job", job.id, "--attempt", String(job.attempt)];
  let reviewContext = "";
  if (job.role === "review" && job.feature_id) {
    const features = require("./features");
    const feature = features.getFeature(root, job.feature_id);
    features.currentCandidate(feature);
    if (job.writable || job.leader !== feature.leader || !feature.review_jobs.includes(job.id)) throw new Error("review assignment does not match the feature requirements");
    const diff = spawnSync("git", ["-C", feature.cwd, "diff", "--no-ext-diff", "--no-textconv", feature.base, feature.candidate.commit, "--"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (diff.error || diff.status !== 0) throw new Error("cannot prepare the integrated review diff");
    const diffPath = path.join(directory, "candidate.diff");
    fs.writeFileSync(diffPath, diff.stdout, { mode: 0o600, flag: "wx" });
    reviewContext = [
      `Feature brief: ${feature.brief}`,
      `Frozen candidate: ${JSON.stringify(feature.candidate)}`,
      `Complete integrated diff: ${diffPath}. Related source: ${feature.cwd}.`,
      `Prior reviews and findings: ${JSON.stringify(feature.reviews)}`,
      "Independently inspect your assigned behavior and interfaces. Return every substantiated required finding, with source evidence, and disclose incomplete coverage.",
      `Your completed team_report result must be a JSON string with candidate=${JSON.stringify(feature.candidate)}, brief_hash=${JSON.stringify(feature.candidate.brief_hash)}, verdict (approve, changes_requested, or block_merge), and findings (array of {id,required,evidence,status,resolution_evidence?}). Send it to the lead's job using to_job or in_reply_to. Required unresolved findings block approval.`
    ].join("\n\n");
  }
  const instructions = [
    `You are job ${job.id}, attempt ${job.attempt}, role ${job.role}, in an Agent Team Harness cmux session.`,
    "Use the agent_team MCP tools for communication. First call team_report with status ready, then team_inbox.",
    "Messages are addressed to your exact job attempt. A wake means read team_inbox; do not infer another agent's reply from terminal output.",
    "Send requests with team_send and answer with team_reply. Work only within this assignment.",
    "Use as many native agents as can usefully work in parallel within available native CLI and account limits, for both coding and reviewing. Split independent responsibilities, refill useful capacity, and avoid duplicate work. Reviewers should fan out across independent risk areas of the complete frozen candidate. There is no harness-imposed child-agent count cap.",
    job.runtime === "claude" ? `Claude Code Agent Teams are enabled. Spawn named native teammates for parallel work; use Fable at ${config.claude.effort} effort throughout. Keep teammates inside this native session.` : `Native Codex subagents are enabled. Use Astra at ${config.codex.effort} effort for every coding, exploration and review agent.`,
    "You own every child agent: assign bounded scope and source context, preserve the job's permission boundary, use private worktrees for simultaneous writers, collect and assess all results, then close or shut down children before reporting terminal completion. Children use native messages to return results; only this parent session may use the harness team MCP identity or report this job complete.",
    "Terminal team_report statuses end this native process after the report is delivered. Report completion only when your assignment is finished.",
    job.writable ? "Use your assigned checkout for edits; keep changes within the stated scope." : "This assignment is read-only. Do not change source files.",
    reviewContext, job.prompt
  ].join("\n\n");
  let argv;
  let session_id;
  if (job.runtime === "claude") {
    session_id = crypto.randomUUID();
    const guard = { type: "command", command: process.execPath, args: [path.join(__dirname, "claudeAgentGuard.js"), directory, session_id, job.writable ? "write" : "read"] };
    const settings = {
      switchModelsOnFlag: false,
      teammateMode: config.claude.teammate_mode,
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: config.claude.agent_teams ? "1" : "0",
        CLAUDE_CODE_EFFORT_LEVEL: config.claude.effort,
        CLAUDE_CODE_SUBAGENT_MODEL: job.model,
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1"
      },
      hooks: {
        PreToolUse: [{ matcher: job.writable ? "mcp__agent_team__.*" : ".*", hooks: [guard] }],
        SubagentStart: [{ hooks: [guard] }],
        SubagentStop: [{ hooks: [guard] }]
      }
    };
    const configPath = path.join(directory, "mcp.json");
    // These four communication tools must be available before the first prompt,
    // including in read-only sessions without the general ToolSearch tool.
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { agent_team: { command: process.execPath, args: serverArgs, alwaysLoad: true } } }), { mode: 0o600, flag: "wx" });
    argv = [options.claude_bin || "claude", "--model", job.model, "--effort", config.claude.effort, "--name", job.id, "--session-id", session_id,
      "--mcp-config", configPath, "--strict-mcp-config", "--permission-mode", job.writable ? "acceptEdits" : "dontAsk",
      // Preserve the assigned model: native safeguards must pause the job,
      // rather than silently fulfilling its assignment on another model.
      "--settings", JSON.stringify(settings),
      "--allowedTools", "Agent", "SendMessage", "mcp__agent_team__*", "mcp__agent_team__team_inbox", "mcp__agent_team__team_send", "mcp__agent_team__team_reply", "mcp__agent_team__team_report"];
    if (!job.writable) argv.push("--tools", [...readTools].join(","));
    if (reviewContext) argv.push("--add-dir", directory);
    argv.push("--", instructions);
  } else if (job.runtime === "codex") {
    const childConfig = path.join(directory, "codex-child.toml");
    fs.writeFileSync(childConfig, [
      `model = ${JSON.stringify(job.model)}`,
      `model_reasoning_effort = ${JSON.stringify(config.codex.effort)}`,
      `developer_instructions = ${JSON.stringify("Use as many native agents as usefully independent work permits within available native and account limits. Keep the assigned model and xhigh effort. Preserve the inherited sandbox and source scope. Concurrent writers need private worktrees. Return results through native agent communication. The owning parent alone may use the harness agent_team MCP identity. Collect all child results and close children before returning.")}`,
      ""
    ].join("\n"), { mode: 0o600, flag: "wx" });
    // CLI -c values are TOML. JSON strings/arrays are also valid TOML here.
    argv = [options.codex_bin || "codex", "--model", job.model, "-C", job.cwd, "--no-alt-screen",
      "--sandbox", job.writable ? "workspace-write" : "read-only", "--ask-for-approval", "on-request",
      "-c", `features.multi_agent=${config.codex.multi_agent}`, "-c", `model_reasoning_effort=${JSON.stringify(config.codex.effort)}`,
      "-c", "features.multi_agent_v2.enabled=true", "-c", "features.multi_agent_v2.expose_spawn_agent_model_overrides=false",
      "-c", "features.step_model_switching=false", "-c", "agents.enabled=true",
      "-c", `review_model=${JSON.stringify(job.model)}`,
      "-c", `agents.default_subagent_model=${JSON.stringify(job.model)}`,
      "-c", `agents.default_subagent_reasoning_effort=${JSON.stringify(config.codex.effort)}`,
      ...["default", "worker", "explorer"].flatMap((role) => ["-c", `agents.${role}.config_file=${JSON.stringify(childConfig)}`]),
      "-c", `mcp_servers.agent_team.command=${JSON.stringify(process.execPath)}`,
      "-c", `mcp_servers.agent_team.args=${JSON.stringify(serverArgs)}`,
      "-c", "mcp_servers.agent_team.required=true", "--", instructions];
  } else throw new Error("unsupported native runtime");
  const file = path.join(directory, "launch.json");
  const launch = { root, job_id: job.id, attempt: job.attempt, cwd: job.cwd, argv, session_id };
  fs.writeFileSync(file, JSON.stringify(launch, null, 2), { mode: 0o600, flag: "wx" });
  return { argv: [process.execPath, path.join(__dirname, "sessionRunner.js"), file], directory };
}

function launchJob(root, id, { max_active, transport = createTransport(), ...options } = {}) {
  let job = jobs.claimJob(root, id, { max_active });
  let command;
  try { command = buildNativeCommand(root, job, options); } catch (error) {
    jobs.finishJob(root, id, job.attempt, { status: "failed", result: error.message, process_stopped: true });
    throw error;
  }
  try {
    const project = require("./project").ensureProject(root, { transport, title: options.project_title });
    const session = transport.createSession({ workspace_id: project.workspace_id, anchor_surface_id: project.surface_id,
      cwd: job.cwd, title: `${job.id} · ${job.runtime}`, command });
    job = jobs.bindJob(root, id, job.attempt, { workspace_id: session.workspace_id, surface_id: session.surface_id });
    return job;
  } catch (error) {
    // The runner may already exist even when allocation loses its response.
    fs.writeFileSync(path.join(command.directory, "launch-error.json"), JSON.stringify({ error: error.message, session: error.session, claim_retained: true }));
    throw error;
  }
}

function wakeMessage(root, message, transport = createTransport()) {
  const target = jobs.getJob(root, message.metadata.to_job);
  if (target.attempt !== message.metadata.to_attempt) throw new Error("refusing stale attempt wake");
  if (target.status !== "running" || !target.ready_at || !target.surface_id) return { status: "pending", reason: "recipient_not_ready" };
  const receipt = transport.sendText({ workspace_id: target.workspace_id, surface_id: target.surface_id,
    text: `Read team_inbox. New addressed message: ${message.id}. Process any unanswered messages.`, submit: true });
  return { status: "submitted", ...receipt, semantic_reply_confirmed: false };
}

function importReview(root, featureId, jobId) {
  const features = require("./features");
  const feature = features.getFeature(root, featureId);
  const job = jobs.getJob(root, jobId);
  if (job.role !== "review" || job.writable || job.leader !== feature.leader || job.runtime !== jobs.routeRuntime(feature.leader, "review") || job.feature_id !== featureId) {
    throw new Error("review must come from a read-only job assigned to this feature using the opposite leader runtime");
  }
  if (job.status !== "completed" || !job.process_stopped || job.reported_result?.status !== "completed") throw new Error("review requires a completed current native attempt");
  const result = JSON.parse(job.reported_result.result);
  return features.recordFeatureReview(root, featureId, { ...result, reviewer_job_id: job.id, attempt: job.attempt });
}

function acceptanceStatus(root, featureId) {
  const features = require("./features");
  const feature = features.getFeature(root, featureId);
  const result = features.featureStatus(root, featureId);
  for (const id of feature.review_jobs) {
    try {
      const job = jobs.getJob(root, id);
      const review = feature.reviews.filter((item) => item.reviewer_job_id === id).at(-1);
      if (job.role !== "review" || job.writable || job.leader !== feature.leader || job.feature_id !== featureId ||
          job.runtime !== jobs.routeRuntime(feature.leader, "review") || job.status !== "completed" || !job.process_stopped ||
          job.reported_result?.status !== "completed" || review?.attempt !== job.attempt) {
        result.reasons.push(`review job is missing current stopped evidence: ${id}`);
      }
    } catch (error) { result.reasons.push(`review job unavailable: ${id}: ${error.message}`); }
  }
  return { ...result, eligible: result.reasons.length === 0 };
}

module.exports = { attemptDirectory, buildNativeCommand, launchJob, wakeMessage, importReview, acceptanceStatus };
