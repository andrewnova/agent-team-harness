const paths = require("./paths");
const { exists, readJson, writeJson } = require("./fsutil");
const { loadTask, recordEvent } = require("./state");
const db = require("./db");

const VERDICTS = new Set(["pass", "changes_requested", "block_merge", "waived"]);

function validateQualityReview(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) throw new Error("quality review must be an object");
  if (typeof review.task_id !== "string" || review.task_id.trim() === "") throw new Error("quality review task_id is required");
  if (typeof review.verdict !== "string" || !VERDICTS.has(review.verdict)) {
    throw new Error("quality review verdict must be pass, changes_requested, block_merge, or waived");
  }
  if (review.findings !== undefined && !Array.isArray(review.findings)) throw new Error("quality review findings must be an array");
  if (review.rationale !== undefined && typeof review.rationale !== "string") throw new Error("quality review rationale must be a string");
  return true;
}

function loadQualityReview(cwd, taskId) {
  const file = paths.qualityPath(cwd, taskId);
  return exists(file) ? readJson(file) : null;
}

function recordQualityReview(cwd, review) {
  validateQualityReview(review);
  const task = loadTask(cwd, review.task_id);
  const row = {
    recorded_at: new Date().toISOString(),
    reviewer: review.reviewer || "codex",
    scope: review.scope || "structural_risk",
    findings: review.findings || [],
    rationale: review.rationale || "",
    ...review,
    task_id: task.task_id,
    goal_id: task.goal_id
  };
  writeJson(paths.qualityPath(cwd, review.task_id), row);
  db.upsertAdvisory(cwd, "quality", review.task_id, row, {
    task_id: task.task_id,
    goal_id: task.goal_id,
    verdict: row.verdict
  });
  recordEvent(cwd, {
    type: "quality.recorded",
    goal_id: task.goal_id,
    task_id: task.task_id,
    owner: task.owner,
    reviewer: task.reviewer,
    status: task.status,
    detail: {
      verdict: row.verdict,
      findings: row.findings.length
    }
  });
  return row;
}

function blockingQualityReview(cwd, taskId) {
  const review = loadQualityReview(cwd, taskId);
  if (review && review.verdict === "block_merge") return review;
  return null;
}

module.exports = {
  validateQualityReview,
  loadQualityReview,
  recordQualityReview,
  blockingQualityReview
};
