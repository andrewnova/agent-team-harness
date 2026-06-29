const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const paths = require("./paths");
const { exists, readJson, writeJson } = require("./fsutil");
const { init, recordEvent } = require("./state");
const db = require("./db");

const DEFAULT_INBOX_DIRS = [
  "docs/planning",
  "docs/schema-changes",
  ".agent-team/comms/codex-inbox",
  ".agent-team/comms/claude-notices"
];

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function noticePath(cwd, noticeId) {
  const safeId = String(noticeId || "notice").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
  return paths.advisoryPath(cwd, "claude-notices", safeId);
}

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) out.push(...listMarkdownFiles(file));
    if (stat.isFile() && /\.(md|markdown)$/i.test(name)) out.push(file);
  }
  return out.sort();
}

function candidateDirs(projectDirs = [], extraDirs = []) {
  const dirs = [];
  for (const projectDir of projectDirs.filter(Boolean)) {
    for (const rel of DEFAULT_INBOX_DIRS) dirs.push(path.join(projectDir, rel));
  }
  dirs.push(...extraDirs.filter(Boolean));
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

function looksLikeClaudeNotice(file, body) {
  const base = path.basename(file).toLowerCase();
  if (/claude.*(notice|steer|steering|audit|supplement|handoff)/.test(base)) return true;
  if (/^#\s*notice\s+for\s+codex\b/im.test(body)) return true;
  if (/\bFrom:\s*Claude\b/i.test(body) && /\bCodex\b/i.test(body)) return true;
  return /\bNOTICE\s+for\s+Codex\b/i.test(body);
}

function firstHeading(body, fallback) {
  const line = body.split(/\r?\n/).find((item) => /^#\s+/.test(item));
  return line ? line.replace(/^#\s+/, "").trim() : fallback;
}

function inferId(body, pattern) {
  const match = body.match(pattern);
  return match ? match[0] : undefined;
}

function normalizeProjectDirs(cwd, options = {}) {
  const dirs = [cwd];
  if (options.project_dir) dirs.push(options.project_dir);
  if (Array.isArray(options.project_dirs)) dirs.push(...options.project_dirs);
  return [...new Set(dirs.filter(Boolean).map((dir) => path.resolve(dir)))];
}

function listNotices(cwd, filter = {}) {
  const dir = path.join(paths.stateDir(cwd), "advisory", "claude-notices");
  if (!fs.existsSync(dir)) return [];
  let rows = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(dir, name)));
  if (filter.status) rows = rows.filter((row) => row.status === filter.status);
  if (filter.task_id) rows = rows.filter((row) => row.task_id === filter.task_id);
  if (!filter.include_archived) rows = rows.filter((row) => row.status !== "archived");
  if (Number.isInteger(filter.limit) && filter.limit > 0) rows = rows.slice(-filter.limit);
  return rows;
}

function existingByDigest(cwd) {
  return new Map(listNotices(cwd, { include_archived: true }).map((notice) => [notice.body_sha256, notice]));
}

function importNotice(cwd, file, body, options = {}) {
  const digest = sha256(body);
  const existing = existingByDigest(cwd).get(digest);
  if (existing) return { imported: false, notice: existing };
  const now = new Date().toISOString();
  const noticeId = `CN-${digest.slice(0, 12)}`;
  const record = {
    notice_id: noticeId,
    source: "claude-file-notice",
    author: "claude",
    status: "new",
    task_id: inferId(body, /\bT-\d{6}\b/),
    goal_id: inferId(body, /\bG-\d{6}\b/),
    title: firstHeading(body, path.basename(file)),
    source_path: file,
    project_dir: options.project_dir,
    body_sha256: digest,
    body_preview: body.slice(0, 1200),
    discovered_at: now,
    updated_at: now,
    steering_required: true,
    advisory_only: true,
    codex_state_authority: true
  };
  writeJson(noticePath(cwd, noticeId), record);
  db.upsertAdvisory(cwd, "claude-notices", noticeId, record, {
    task_id: record.task_id,
    goal_id: record.goal_id
  });
  recordEvent(cwd, {
    type: "claude_notice.imported",
    actor: "claude",
    goal_id: record.goal_id,
    task_id: record.task_id,
    detail: {
      notice_id: noticeId,
      title: record.title,
      source_path: record.source_path,
      steering_required: true
    }
  });
  return { imported: true, notice: record };
}

function scanClaudeNotices(cwd, options = {}) {
  init(cwd);
  const projectDirs = normalizeProjectDirs(cwd, options);
  const dirs = candidateDirs(projectDirs, options.dirs || []);
  const matchedFiles = [];
  const imported = [];
  const skipped = [];
  for (const dir of dirs) {
    for (const file of listMarkdownFiles(dir)) {
      const stat = fs.statSync(file);
      if (stat.size > (options.max_bytes || 1024 * 1024)) {
        skipped.push({ file, reason: "too_large" });
        continue;
      }
      const body = fs.readFileSync(file, "utf8");
      if (!looksLikeClaudeNotice(file, body)) continue;
      matchedFiles.push(file);
      const projectDir = projectDirs.find((candidate) => file.startsWith(`${candidate}${path.sep}`));
      const result = importNotice(cwd, file, body, { project_dir: projectDir });
      if (result.imported) imported.push(result.notice);
    }
  }
  return {
    ok: true,
    scanned_dirs: dirs,
    matched_files: matchedFiles,
    imported,
    skipped,
    pending: listNotices(cwd, { status: "new" })
  };
}

function loadNotice(cwd, noticeId) {
  const file = noticePath(cwd, noticeId);
  return exists(file) ? readJson(file) : null;
}

function ackNotice(cwd, noticeId, input = {}) {
  init(cwd);
  const notice = loadNotice(cwd, noticeId);
  if (!notice) return { ok: false, error: `Claude notice not found: ${noticeId}` };
  const status = input.status || "acknowledged";
  const updated = {
    ...notice,
    status,
    codex_note: input.note || notice.codex_note || "",
    acknowledged_at: status === "acknowledged" ? new Date().toISOString() : notice.acknowledged_at,
    applied_at: status === "applied" ? new Date().toISOString() : notice.applied_at,
    rejected_at: status === "rejected" ? new Date().toISOString() : notice.rejected_at,
    updated_at: new Date().toISOString()
  };
  writeJson(noticePath(cwd, noticeId), updated);
  db.upsertAdvisory(cwd, "claude-notices", noticeId, updated, {
    task_id: updated.task_id,
    goal_id: updated.goal_id
  });
  recordEvent(cwd, {
    type: `claude_notice.${status}`,
    actor: "codex",
    goal_id: updated.goal_id,
    task_id: updated.task_id,
    detail: {
      notice_id: noticeId,
      title: updated.title,
      note: updated.codex_note
    }
  });
  return { ok: true, notice: updated };
}

module.exports = {
  scanClaudeNotices,
  listNotices,
  loadNotice,
  ackNotice,
  DEFAULT_INBOX_DIRS
};
