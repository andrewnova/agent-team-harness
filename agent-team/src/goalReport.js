const path = require("node:path");
const paths = require("./paths");
const { writeText } = require("./fsutil");
const state = require("./state");
const { loadProof } = require("./proof");
const { loadMerge } = require("./merge");
const { finalCheck } = require("./finalCheck");
const { listMessages, compactMessage } = require("./mailbox");
const { daemonStatus, stopDaemon } = require("./daemon");
const { listSelfHealRecommendations } = require("./feedback");

function relative(cwd, file) {
  return path.relative(cwd, file) || file;
}

function resolveGoalId(cwd, explicit) {
  if (explicit) return explicit;
  const taskGoals = [...new Set(state.listTasks(cwd).map((task) => task.goal_id).filter(Boolean))];
  if (taskGoals.length === 1) return taskGoals[0];
  const goals = state.listGoals(cwd);
  if (goals.length === 1) return goals[0].goal_id;
  return undefined;
}

function taskRows(cwd, goalId) {
  return state.listTasks(cwd).filter((task) => !goalId || task.goal_id === goalId);
}

function proofArtifacts(proof) {
  if (!proof) return [];
  const artifacts = proof.artifacts || {};
  return [
    ...(artifacts.browser_runs || []).map((item) => `browser: ${item}`),
    ...(artifacts.screenshots || []).map((item) => `screenshot: ${item}`),
    ...(artifacts.console_checks || []).map((item) => `console: ${item}`),
    ...(artifacts.computer_runs || []).map((item) => `computer: ${item}`),
    ...(artifacts.browser_findings || []).map((item) => `browser findings: ${item}`)
  ];
}

function renderGoalReport(cwd, options = {}) {
  const goalId = resolveGoalId(cwd, options.goal_id);
  const effectiveGoalId = goalId === "workspace" ? undefined : goalId;
  const goal = effectiveGoalId ? state.listGoals(cwd).find((row) => row.goal_id === effectiveGoalId) : null;
  const tasks = taskRows(cwd, effectiveGoalId);
  const final = finalCheck(cwd, { allow_empty: true });
  const daemon = daemonStatus(cwd);
  const messages = listMessages(cwd, { goal_id: effectiveGoalId }).slice(-20);
  const selfHeal = listSelfHealRecommendations(cwd, { goal_id: effectiveGoalId, limit: 10 });
  const lines = [
    "# GOAL_REPORT",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Goal: ${goalId || "workspace"}`,
    `Title: ${goal ? goal.title : "n/a"}`,
    `Status: ${goal ? goal.status : "n/a"}`,
    "",
    "## Final Verification",
    "",
    `- OK: ${final.ok}`,
    `- Tasks: ${final.tasks.total} total, ${final.tasks.done} done, ${final.tasks.open} open`,
    `- Active leases: ${final.active_leases.length}`,
    `- Unfinished worktrees: ${final.worktrees.unfinished.length}`,
    ...(final.issues.length ? final.issues.map((issue) => `- Issue: ${issue}`) : ["- Issues: none"]),
    ...(final.warnings.length ? final.warnings.map((warning) => `- Warning: ${warning}`) : ["- Warnings: none"]),
    "",
    "## Tasks",
    ""
  ];
  if (!tasks.length) {
    lines.push("- None");
  } else {
    for (const task of tasks) {
      const proof = loadProof(cwd, task.task_id);
      const merge = loadMerge(cwd, task.task_id);
      lines.push(`- ${task.task_id} [${task.status}] ${task.owner} -> ${task.reviewer}: ${task.title}`);
      lines.push(`  - Merge: ${merge ? `${merge.strategy || "recorded"} ${merge.merge_ref || merge.tree_hash || ""}`.trim() : "missing"}`);
      lines.push(`  - Proof: ${proof ? `${proof.verdict} ${paths.proofPath(cwd, task.task_id)}` : "missing"}`);
      const artifacts = proofArtifacts(proof);
      if (artifacts.length) {
        for (const artifact of artifacts) lines.push(`  - Artifact: ${artifact}`);
      }
    }
  }
  lines.push(
    "",
    "## Mailbox Summary",
    "",
    `- Messages in goal scope: ${messages.length}`,
    `- Mailbox is truth: true`,
    `- Live channel role: opportunistic startup/smoke only`,
    ...(messages.length
      ? messages.map((message) => {
          const compact = compactMessage(message);
          return `- ${compact.created_at} ${compact.from}->${compact.to}/${compact.kind} ${compact.id}: ${compact.subject || compact.body_preview || "message"}`;
        })
      : ["- No goal-scoped mailbox messages"]),
    "",
    "## Daemon",
    "",
    `- Running: ${daemon.running}`,
    `- Stale pid: ${daemon.stale_pid}`,
    `- Log: ${daemon.log_path}`,
    `- Error log: ${daemon.error_log_path}`,
    "",
    "## Self-Heal And Optional Refactors",
    "",
    ...(selfHeal.length
      ? selfHeal.map((item) => `- ${item.recommendation_id} [${item.status}] ${item.source}/${item.target_surface}: ${item.title}`)
      : ["- No pending goal-scoped self-heal recommendations"]),
    "",
    "## Notes",
    "",
    "- Codex remains final state, merge, proof, and done authority.",
    "- Browser/computer-use proof artifacts are evidence records, not model confidence.",
    "- Old receipts and live-channel rows are audit records once matching durable replies and task closeout are recorded."
  );
  return lines.join("\n");
}

function generateGoalReport(cwd, options = {}) {
  const goalId = resolveGoalId(cwd, options.goal_id) || "workspace";
  const out = options.out ? path.resolve(cwd, options.out) : paths.goalReportPath(cwd, goalId);
  const body = renderGoalReport(cwd, { goal_id: goalId });
  writeText(out, body);
  state.recordEvent(cwd, {
    type: "goal.report_generated",
    actor: "codex",
    goal_id: goalId === "workspace" ? undefined : goalId,
    detail: {
      report_path: relative(cwd, out)
    }
  });
  return {
    ok: true,
    goal_id: goalId,
    report_path: out,
    report_relative: relative(cwd, out)
  };
}

function closeout(cwd, options = {}) {
  const goalId = resolveGoalId(cwd, options.goal_id);
  const final = finalCheck(cwd, { allow_empty: Boolean(options.allow_empty) });
  const report = generateGoalReport(cwd, { goal_id: goalId, out: options.out });
  let daemon = daemonStatus(cwd);
  let daemon_action = {
    action: "reported",
    running: daemon.running
  };
  if (options.stop_daemon && daemon.running) {
    daemon_action = stopDaemon(cwd, { reason: "closeout" });
    daemon = daemonStatus(cwd);
  }
  return {
    ok: final.ok,
    final,
    report,
    daemon,
    daemon_action,
    mailbox_truth: true,
    live_channel_role: "opportunistic startup/smoke only",
    next: final.ok ? "Share GOAL_REPORT.md and decide on optional refactor/self-heal offers." : "Fix final verification blockers, then rerun closeout."
  };
}

module.exports = {
  resolveGoalId,
  renderGoalReport,
  generateGoalReport,
  closeout
};
