const paths = require("./paths");
const { exists, readJson, writeJson } = require("./fsutil");
const { loadTask, recordEvent } = require("./state");
const { transitionTask } = require("./transitions");
const { sourceSnapshot } = require("./proof");
const { blockingQualityReview } = require("./quality");
const { loadWorktree } = require("./worktrees");
const db = require("./db");

function loadMerge(cwd, taskId) {
  const file = paths.mergePath(cwd, taskId);
  return exists(file) ? readJson(file) : null;
}

function recordMerge(cwd, taskId, options = {}) {
  const task = loadTask(cwd, taskId);
  if (task.status !== "merge") {
    return {
      ok: false,
      errors: [`task must be merge before recording final tree, got ${task.status}`]
    };
  }
  const qualityBlocker = blockingQualityReview(cwd, taskId);
  if (qualityBlocker) {
    return {
      ok: false,
      errors: ["quality gate blocks merge"],
      quality: qualityBlocker
    };
  }
  const worktree = loadWorktree(cwd, taskId);
  if (worktree && worktree.status !== "merged") {
    return {
      ok: false,
      errors: [`task worktree must be merged before final tree record, got ${worktree.status}`],
      worktree
    };
  }
  const snapshot = sourceSnapshot(cwd);
  const merge = {
    task_id: task.task_id,
    goal_id: task.goal_id,
    owner: task.owner,
    reviewer: task.reviewer,
    strategy: options.strategy || "serial",
    merge_ref: options.merge_ref || snapshot.merge_ref,
    tree_hash: options.tree_hash || snapshot.tree_hash,
    source_digest: snapshot.source_digest,
    source_state: snapshot,
    worktree: worktree
      ? {
          branch: worktree.branch,
          worktree_path: worktree.worktree_path,
          snapshot_commit: worktree.snapshot_commit,
          status: worktree.status
        }
      : null,
    note: options.note || "MVP serial merge record",
    recorded_at: new Date().toISOString()
  };
  writeJson(paths.mergePath(cwd, taskId), merge);
  db.upsertMerge(cwd, merge);
  recordEvent(cwd, {
    type: "merge.recorded",
    goal_id: task.goal_id,
    task_id: task.task_id,
    owner: task.owner,
    reviewer: task.reviewer,
    status: task.status,
    detail: {
      strategy: merge.strategy,
      merge_ref: merge.merge_ref,
      tree_hash: merge.tree_hash,
      dirty: merge.source_state.dirty,
      changed_count: merge.source_state.changed_count
    }
  });
  const transition = transitionTask(cwd, taskId, "verifying");
  return {
    ok: transition.ok,
    merge,
    transition
  };
}

module.exports = {
  loadMerge,
  recordMerge
};
