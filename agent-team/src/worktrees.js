const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const paths = require("./paths");
const { exists, readJson, writeJson, ensureDir } = require("./fsutil");
const { loadTask, saveTask, recordEvent } = require("./state");
const { transitionTask } = require("./transitions");
const { claimLeasesForTask, releaseLeases } = require("./leases");
const { normalizePath, normalizeChangedPath, isPathAllowed } = require("./pathScope");
const db = require("./db");

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: options.timeout_ms || 15000,
    maxBuffer: options.max_buffer || 20 * 1024 * 1024,
    env: options.env || process.env
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? result.error.message : undefined
  };
}

function gitRequired(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (!result.ok) {
    const detail = (result.stderr || result.error || result.stdout || `git exited ${result.status}`).trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function safeBranch(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "")
    .slice(0, 120);
}

function defaultBranch(taskId) {
  return safeBranch(`agent-team/${taskId}`);
}

function defaultWorktreePath(cwd, taskId) {
  return path.join(paths.worktreesDir(cwd), taskId);
}

function rollbackReadyClaim(cwd, task, reason) {
  const current = loadTask(cwd, task.task_id);
  if (task.status !== "ready" || current.status !== "claimed") return null;
  const restored = saveTask(cwd, {
    ...current,
    status: "ready"
  });
  recordEvent(cwd, {
    type: "task.transition_rollback",
    goal_id: restored.goal_id,
    task_id: restored.task_id,
    owner: restored.owner,
    reviewer: restored.reviewer,
    status: restored.status,
    detail: {
      from: "claimed",
      to: "ready",
      reason
    }
  });
  return restored;
}

function loadWorktree(cwd, taskId) {
  const file = paths.worktreePath(cwd, taskId);
  return exists(file) ? readJson(file) : null;
}

function saveWorktree(cwd, record) {
  writeJson(paths.worktreePath(cwd, record.task_id), record);
  db.upsertWorktree(cwd, record);
  return record;
}

function listWorktrees(cwd) {
  const dir = path.join(paths.stateDir(cwd), "worktrees");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(dir, name)));
}

function currentRef(cwd) {
  const branch = git(cwd, ["branch", "--show-current"]);
  if (branch.ok && branch.stdout.trim()) return branch.stdout.trim();
  const head = gitRequired(cwd, ["rev-parse", "HEAD"]);
  return head.stdout.trim();
}

function changedPaths(worktreePath) {
  const status = gitRequired(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return status.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((file) => file.replace(/^"|"$/g, ""))
    .map((file) => (file.includes(" -> ") ? file.split(" -> ").pop() : file))
    .map(normalizePath);
}

function createWorktree(cwd, taskId, options = {}) {
  const task = loadTask(cwd, taskId);
  const existing = loadWorktree(cwd, taskId);
  if (existing && existing.status !== "removed") {
    return { ok: true, action: "already_exists", worktree: existing };
  }
  const lease = claimLeasesForTask(cwd, task, {
    reason: options.reason || "task worktree created"
  });
  if (!lease.ok) return { ok: false, action: "lease_conflict", lease };
  let claimedFromReady = false;
  if (task.status === "ready") {
    const transition = transitionTask(cwd, taskId, "claimed");
    if (!transition.ok) {
      releaseLeases(cwd, taskId, "worktree claim transition failed");
      return { ok: false, action: "claim_failed", lease, transition };
    }
    claimedFromReady = true;
  }
  const base_ref = options.base_ref || currentRef(cwd);
  const branch = safeBranch(options.branch || defaultBranch(taskId)) || defaultBranch(taskId);
  const worktreePath = path.resolve(cwd, options.path || defaultWorktreePath(cwd, taskId));
  ensureDir(path.dirname(worktreePath));
  const addArgs = ["worktree", "add"];
  if (options.force) addArgs.push("--force");
  addArgs.push("-b", branch, worktreePath, base_ref);
  const added = git(cwd, addArgs, { timeout_ms: options.timeout_ms || 30000 });
  if (!added.ok) {
    releaseLeases(cwd, taskId, "worktree creation failed");
    const rollback = claimedFromReady ? rollbackReadyClaim(cwd, task, "worktree creation failed") : null;
    return {
      ok: false,
      action: "worktree_add_failed",
      lease,
      rollback,
      command: `git ${addArgs.join(" ")}`,
      stdout: added.stdout,
      stderr: added.stderr,
      error: added.error
    };
  }
  const baseHead = gitRequired(worktreePath, ["rev-parse", "HEAD"]).stdout.trim();
  const record = saveWorktree(cwd, {
    task_id: task.task_id,
    goal_id: task.goal_id,
    owner: task.owner,
    reviewer: task.reviewer,
    branch,
    base_ref,
    base_head: baseHead,
    worktree_path: worktreePath,
    merge_target_path: cwd,
    merge_target_ref: currentRef(cwd),
    allowed_paths: task.allowed_paths,
    forbidden_paths: task.forbidden_paths,
    status: "active",
    created_at: new Date().toISOString(),
    last_git_stdout: added.stdout.trim(),
    last_git_stderr: added.stderr.trim()
  });
  recordEvent(cwd, {
    type: "worktree.created",
    goal_id: task.goal_id,
    task_id: task.task_id,
    owner: task.owner,
    reviewer: task.reviewer,
    status: task.status,
    detail: {
      branch,
      base_ref,
      worktree_path: worktreePath
    }
  });
  return { ok: true, action: "created", lease, worktree: record };
}

function worktreeStatus(cwd, taskId) {
  const record = loadWorktree(cwd, taskId);
  if (!record) return { ok: false, error: `worktree not found for ${taskId}` };
  const existsOnDisk = fs.existsSync(record.worktree_path);
  const status = existsOnDisk ? git(record.worktree_path, ["status", "--porcelain=v1", "--untracked-files=all"]) : null;
  return {
    ok: Boolean(existsOnDisk && status && status.ok),
    worktree: record,
    exists: existsOnDisk,
    changed_paths: status && status.ok ? changedPaths(record.worktree_path) : [],
    git_status: status
      ? {
          ok: status.ok,
          stdout: status.stdout,
          stderr: status.stderr,
          status: status.status
        }
      : null
  };
}

function snapshotWorktree(cwd, taskId, options = {}) {
  const task = loadTask(cwd, taskId);
  const record = loadWorktree(cwd, taskId);
  if (!record) return { ok: false, error: `worktree not found for ${taskId}` };
  if (!fs.existsSync(record.worktree_path)) return { ok: false, error: `worktree path missing: ${record.worktree_path}` };
  const changes = changedPaths(record.worktree_path);
  const outOfScope = changes.filter((file) => !isPathAllowed(file, task));
  if (outOfScope.length) {
    return {
      ok: false,
      error: "worktree changes outside task path scope",
      changed_paths: changes,
      out_of_scope: outOfScope,
      allowed_paths: task.allowed_paths,
      forbidden_paths: task.forbidden_paths
    };
  }
  if (!changes.length) return { ok: true, action: "no_changes", worktree: record, changed_paths: [] };
  const add = git(record.worktree_path, ["add", "--", ...changes]);
  if (!add.ok) return { ok: false, action: "add_failed", stdout: add.stdout, stderr: add.stderr };
  const message = options.message || `Snapshot ${taskId}: ${task.title}`;
  const commit = git(record.worktree_path, [
    "-c",
    "user.name=Agent Team",
    "-c",
    "user.email=agent-team@example.test",
    "commit",
    "-m",
    message
  ]);
  if (!commit.ok) return { ok: false, action: "commit_failed", stdout: commit.stdout, stderr: commit.stderr };
  const head = gitRequired(record.worktree_path, ["rev-parse", "HEAD"]).stdout.trim();
  const updated = saveWorktree(cwd, {
    ...record,
    status: "snapshotted",
    changed_paths: changes,
    snapshot_commit: head,
    snapshot_message: message,
    snapshotted_at: new Date().toISOString()
  });
  recordEvent(cwd, {
    type: "worktree.snapshotted",
    goal_id: task.goal_id,
    task_id: task.task_id,
    owner: task.owner,
    reviewer: task.reviewer,
    status: task.status,
    detail: {
      branch: record.branch,
      commit: head,
      changed_paths: changes
    }
  });
  return { ok: true, action: "snapshotted", worktree: updated };
}

function mergeWorktree(cwd, taskId, options = {}) {
  const task = loadTask(cwd, taskId);
  if (task.status !== "merge") {
    return { ok: false, error: `task must be merge before worktree merge, got ${task.status}` };
  }
  const record = loadWorktree(cwd, taskId);
  if (!record) return { ok: false, error: `worktree not found for ${taskId}` };
  if (!record.snapshot_commit) return { ok: false, error: "worktree must be snapshotted before merge" };
  const mergeArgs = ["merge", "--squash", record.snapshot_commit];
  const merged = git(cwd, mergeArgs, { timeout_ms: options.timeout_ms || 30000, max_buffer: 50 * 1024 * 1024 });
  if (!merged.ok) {
    const updated = saveWorktree(cwd, {
      ...record,
      status: "merge_conflict",
      merge_attempted_at: new Date().toISOString(),
      merge_stdout: merged.stdout,
      merge_stderr: merged.stderr
    });
    recordEvent(cwd, {
      type: "worktree.merge_conflict",
      goal_id: task.goal_id,
      task_id: task.task_id,
      owner: task.owner,
      reviewer: task.reviewer,
      status: task.status,
      detail: {
        branch: record.branch,
        commit: record.snapshot_commit,
        stderr: merged.stderr
      }
    });
    return { ok: false, action: "merge_conflict", worktree: updated, stdout: merged.stdout, stderr: merged.stderr };
  }
  const updated = saveWorktree(cwd, {
    ...record,
    status: "merged",
    merged_at: new Date().toISOString(),
    merge_stdout: merged.stdout,
    merge_stderr: merged.stderr
  });
  recordEvent(cwd, {
    type: "worktree.merged",
    goal_id: task.goal_id,
    task_id: task.task_id,
    owner: task.owner,
    reviewer: task.reviewer,
    status: task.status,
    detail: {
      branch: record.branch,
      commit: record.snapshot_commit
    }
  });
  return { ok: true, action: "merged", worktree: updated, stdout: merged.stdout, stderr: merged.stderr };
}

module.exports = {
  createWorktree,
  worktreeStatus,
  snapshotWorktree,
  mergeWorktree,
  loadWorktree,
  listWorktrees,
  normalizeChangedPath,
  pathAllowed: isPathAllowed,
  changedPaths
};
