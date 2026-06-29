const path = require("node:path");
const { writeText } = require("./fsutil");
const paths = require("./paths");
const { loadTask, saveTask, attemptsFor, recordEvent } = require("./state");

function sameBlockerAttempts(attempts, owner, blocker) {
  return attempts.filter((attempt) => attempt.owner === owner && attempt.blocker === blocker && attempt.result === "failed");
}

function nextOwner(owner) {
  if (owner === "codex") return "claude";
  if (owner === "claude") return "codex";
  return "human";
}

function evaluateHandoff(cwd, taskId) {
  const task = loadTask(cwd, taskId);
  const attempts = attemptsFor(cwd, taskId);
  const latest = attempts[attempts.length - 1];
  if (!latest || latest.result !== "failed" || !latest.blocker) {
    return { action: "continue", task, attempts };
  }
  const failedSame = sameBlockerAttempts(attempts, latest.owner, latest.blocker);
  if (failedSame.length < (task.escalation_policy.max_attempts_per_owner || 3)) {
    return { action: "continue", task, attempts, blocker: latest.blocker };
  }
  const other = nextOwner(latest.owner);
  const otherFailed = sameBlockerAttempts(attempts, other, latest.blocker);
  if (otherFailed.length >= (task.escalation_policy.max_attempts_per_owner || 3)) {
    task.status = "human";
    const saved = saveTask(cwd, task);
    recordEvent(cwd, {
      type: "task.escalated",
      goal_id: saved.goal_id,
      task_id: saved.task_id,
      owner: saved.owner,
      reviewer: saved.reviewer,
      status: saved.status,
      detail: {
        blocker: latest.blocker,
        failed_attempts: failedSame.length + otherFailed.length,
        reason: "both owners exhausted retry budget"
      }
    });
    return { action: "human", task, attempts, blocker: latest.blocker };
  }
  const previousOwner = task.owner;
  task.status = "handoff";
  task.owner = other;
  task.reviewer = latest.owner;
  const saved = saveTask(cwd, task);
  const pack = renderHandoff(task, attempts, latest.blocker);
  const file = path.join(paths.rootDir(cwd), "handoffs", `${task.task_id}-to-${other}.md`);
  writeText(file, pack);
  recordEvent(cwd, {
    type: "task.handoff",
    goal_id: saved.goal_id,
    task_id: saved.task_id,
    owner: saved.owner,
    reviewer: saved.reviewer,
    status: saved.status,
    detail: {
      from: previousOwner,
      to: other,
      blocker: latest.blocker,
      file: path.relative(cwd, file)
    }
  });
  return { action: "handoff", task, attempts, blocker: latest.blocker, file };
}

function renderHandoff(task, attempts, blocker) {
  const failed = attempts.filter((attempt) => attempt.blocker === blocker);
  return [
    `# Handoff: ${task.task_id} to ${task.owner}`,
    "",
    `Status: ${task.status}`,
    `Blocker: ${blocker}`,
    "",
    "## Objective",
    "",
    task.objective,
    "",
    "## Acceptance Criteria",
    "",
    ...task.acceptance_criteria.map((item) => `- ${item}`),
    "",
    "## Failed Attempts",
    "",
    ...failed.map((attempt) => `- ${attempt.owner} attempt ${attempt.attempt}: ${attempt.hypothesis}`),
    "",
    "## Recommended Next Attempt",
    "",
    "Use the failed hypotheses above; do not repeat them without new evidence."
  ].join("\n");
}

module.exports = {
  evaluateHandoff,
  renderHandoff
};
