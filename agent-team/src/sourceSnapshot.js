const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

function gitOutput(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: options.timeout_ms || 5000,
    maxBuffer: options.max_buffer || 20 * 1024 * 1024
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
    error: result.error ? result.error.message : undefined
  };
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sourcePathspec() {
  return ["--", ".", ":(exclude).agent-team"];
}

function sourceSnapshot(cwd) {
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) {
    return {
      available: false,
      reason: "not_git_worktree",
      tree_hash: "unknown-tree",
      merge_ref: "unknown-ref",
      source_digest: "unknown-source"
    };
  }
  const head = gitOutput(cwd, ["rev-parse", "HEAD"]);
  const branch = gitOutput(cwd, ["branch", "--show-current"]);
  const status = gitOutput(cwd, ["status", "--porcelain=v1", "--untracked-files=all", ...sourcePathspec()]);
  const unstaged = gitOutput(cwd, ["diff", "--binary", ...sourcePathspec()], { max_buffer: 50 * 1024 * 1024 });
  const staged = gitOutput(cwd, ["diff", "--cached", "--binary", ...sourcePathspec()], { max_buffer: 50 * 1024 * 1024 });
  if (!head.ok || !status.ok || !unstaged.ok || !staged.ok) {
    return {
      available: false,
      reason: "git_source_snapshot_failed",
      tree_hash: head.stdout.trim() || "unknown-tree",
      merge_ref: branch.stdout.trim() || "unknown-ref",
      source_digest: "unknown-source",
      errors: [head, status, unstaged, staged]
        .filter((item) => !item.ok)
        .map((item) => (item.stderr || item.error || `git exited ${item.status}`).trim())
    };
  }
  const statusLines = status.stdout.split(/\r?\n/).filter(Boolean);
  const payload = JSON.stringify({
    root: root.stdout.trim(),
    head: head.stdout.trim(),
    branch: branch.stdout.trim() || "detached-head",
    status: status.stdout,
    unstaged_hash: hashText(unstaged.stdout),
    staged_hash: hashText(staged.stdout)
  });
  return {
    available: true,
    tree_hash: head.stdout.trim(),
    merge_ref: branch.stdout.trim() || "detached-head",
    source_digest: hashText(payload),
    dirty: statusLines.length > 0,
    changed_paths: statusLines.map((line) => line.slice(3)).slice(0, 50),
    changed_count: statusLines.length
  };
}

module.exports = {
  gitOutput,
  hashText,
  sourceSnapshot
};
