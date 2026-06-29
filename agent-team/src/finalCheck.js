const state = require("./state");
const { loadProof, evaluateProof, sourceSnapshot } = require("./proof");
const { loadMerge } = require("./merge");
const { activeLeases } = require("./leases");
const { listWorktrees } = require("./worktrees");

function finalCheck(cwd, options = {}) {
  state.init(cwd);
  const tasks = state.listTasks(cwd);
  const source = sourceSnapshot(cwd);
  const issues = [];
  const warnings = [];
  if (!tasks.length && !options.allow_empty) {
    issues.push("no tasks recorded");
  }
  for (const task of tasks) {
    if (task.status !== "done") {
      issues.push(`${task.task_id} is ${task.status}, not done`);
      continue;
    }
    const merge = loadMerge(cwd, task.task_id);
    if (!merge) issues.push(`${task.task_id} has no merge record`);
    const proof = loadProof(cwd, task.task_id);
    if (!proof) {
      issues.push(`${task.task_id} has no proof manifest`);
      continue;
    }
    const proofResult = evaluateProof(cwd, { ...task, status: "verifying" }, proof);
    for (const error of proofResult.errors) issues.push(`${task.task_id}: ${error}`);
    if (
      merge &&
      proof.source_digest &&
      merge.source_digest &&
      proof.source_digest !== merge.source_digest &&
      source.available &&
      proof.source_digest === source.source_digest
    ) {
      warnings.push(`${task.task_id}: proof was refreshed on a later final tree than its original merge record`);
    }
  }
  const active = activeLeases(cwd);
  if (active.length) {
    issues.push(`active leases remain: ${active.map((lease) => `${lease.task_id}:${lease.lease_id}`).join(", ")}`);
  }
  const worktrees = listWorktrees(cwd);
  const unfinishedWorktrees = worktrees.filter((worktree) => !["merged", "removed"].includes(worktree.status));
  if (unfinishedWorktrees.length) {
    issues.push(`unfinished worktrees remain: ${unfinishedWorktrees.map((worktree) => `${worktree.task_id}:${worktree.status}`).join(", ")}`);
  }
  return {
    ok: issues.length === 0,
    source,
    tasks: {
      total: tasks.length,
      done: tasks.filter((task) => task.status === "done").length,
      open: tasks.filter((task) => task.status !== "done").length
    },
    active_leases: active,
    worktrees: {
      total: worktrees.length,
      unfinished: unfinishedWorktrees
    },
    issues,
    warnings
  };
}

module.exports = {
  finalCheck
};
