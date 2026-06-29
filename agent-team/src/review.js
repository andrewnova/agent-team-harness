const { readJson, readJsonl, writeJson, exists } = require("./fsutil");
const paths = require("./paths");
const { validateReview } = require("./schema");
const { loadTask, recordEvent } = require("./state");
const { createBridge } = require("./bridge");
const { findMailboxResponse } = require("./mailbox");
const db = require("./db");

function recordReview(cwd, review) {
  validateReview(review);
  const task = loadTask(cwd, review.task_id);
  const row = {
    recorded_at: new Date().toISOString(),
    ...review
  };
  writeJson(paths.reviewPath(cwd, review.task_id, review.reviewer), row);
  db.upsertReview(cwd, row);
  recordEvent(cwd, {
    type: "review.recorded",
    goal_id: task.goal_id,
    task_id: review.task_id,
    owner: review.owner,
    reviewer: review.reviewer,
    status: task.status,
    detail: {
      verdict: review.verdict,
      required_fixes: review.required_fixes.length,
      optional_suggestions: review.optional_suggestions.length,
      questions: review.questions.length
    }
  });
  return review;
}

function buildReviewPrompt(task, extraPrompt = "") {
  return [
    `Review task ${task.task_id} as ${task.reviewer}.`,
    "",
    "Return only JSON matching this schema:",
    JSON.stringify(
      {
        task_id: task.task_id,
        reviewer: task.reviewer,
        owner: task.owner,
        verdict: "approve | changes_requested | block_merge | waived",
        required_fixes: [{ file: "path", issue: "problem", fix: "minimal fix" }],
        optional_suggestions: ["optional improvement"],
        questions: ["blocking question"]
      },
      null,
      2
    ),
    "",
    "Review rules:",
    "- Be adversarial about correctness, regressions, overbuilding, and missing proof.",
    "- For frontend work, Codex must verify integration, browser behavior, console state, responsive fit, and screenshots when required.",
    "- For backend work, Claude should challenge complexity, missed edge cases, and simpler alternatives.",
    "- Use approve only when no required fixes remain.",
    "",
    "Task:",
    JSON.stringify(task, null, 2),
    extraPrompt ? ["", "Extra reviewer instructions:", extraPrompt].join("\n") : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function requestReview(cwd, taskId, options = {}) {
  const task = loadTask(cwd, taskId);
  const adapter = createBridge(options.adapter || "mailbox");
  const row = adapter.request(cwd, {
    task_id: taskId,
    kind: "review",
    owner: task.owner,
    reviewer: task.reviewer,
    prompt: buildReviewPrompt(task, options.prompt || options.extra_prompt || ""),
    target: options.target,
    timeout_ms: options.timeout_ms
  });
  recordEvent(cwd, {
    type: "review.requested",
    goal_id: task.goal_id,
    task_id: task.task_id,
    owner: task.owner,
    reviewer: task.reviewer,
    status: task.status,
    detail: {
      adapter: row.adapter,
      request_id: row.request_id,
      target: row.target || options.target
    }
  });
  return row;
}

function loadReview(cwd, taskId, reviewer) {
  const file = paths.reviewPath(cwd, taskId, reviewer);
  if (!exists(file)) return null;
  return readJson(file);
}

function approvedReview(cwd, task) {
  const review = loadReview(cwd, task.task_id, task.reviewer);
  if (!review) return null;
  if (review.verdict === "approve" || review.verdict === "waived") return review;
  return null;
}

function responseText(response) {
  if (!response) return "";
  if (response.answer !== undefined) return response.answer;
  if (response.text !== undefined) return response.text;
  if (response.stdout !== undefined) return response.stdout;
  if (response.body !== undefined) return response.body;
  if (response.body_inline !== undefined) return response.body_inline;
  if (response.payload !== undefined) return JSON.stringify(response.payload);
  return JSON.stringify(response);
}

function parseJsonish(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = String(value || "").trim();
  if (!text) throw new Error("review response is empty");
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("review response does not contain parseable JSON");
  }
}

function findReviewResponse(cwd, taskId, requestId) {
  const mailboxResponse = findMailboxResponse(cwd, { task_id: taskId, request_id: requestId, kind: "review" });
  if (mailboxResponse) return mailboxResponse;
  const responses = readJsonl(paths.responsesPath(cwd));
  const matches = requestId
    ? responses.filter((row) => row.request_id === requestId || row.channel_request_id === requestId)
    : responses.filter((row) => row.task_id === taskId && row.kind === "review");
  return matches[matches.length - 1] || null;
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function reviewFromPayload(task, payload) {
  const verdict = payload.verdict || "changes_requested";
  const findings = arrayValue(payload.findings);
  return {
    task_id: payload.task_id || task.task_id,
    reviewer: payload.reviewer || task.reviewer,
    owner: payload.owner || task.owner,
    verdict,
    summary: payload.summary,
    required_fixes:
      payload.required_fixes !== undefined
        ? arrayValue(payload.required_fixes)
        : verdict === "approve" || verdict === "waived"
          ? []
          : findings,
    optional_suggestions:
      payload.optional_suggestions !== undefined
        ? arrayValue(payload.optional_suggestions)
        : verdict === "approve" || verdict === "waived"
          ? findings
          : [],
    questions: arrayValue(payload.questions)
  };
}

function importReview(cwd, taskId, options = {}) {
  const task = loadTask(cwd, taskId);
  const response = findReviewResponse(cwd, taskId, options.request_id);
  if (!response) {
    throw new Error(options.request_id ? `no review response found for request ${options.request_id}` : `no review response found for ${taskId}`);
  }
  if (response.result_state && response.result_state !== "answered") {
    throw new Error(`review response is not answered: ${response.result_state}`);
  }
  const payload = response.payload !== undefined ? response.payload : parseJsonish(responseText(response));
  const review = reviewFromPayload(task, parseJsonish(payload));
  recordReview(cwd, review);
  return {
    ok: true,
    task_id: taskId,
    request_id: response.request_id,
    channel_request_id: response.channel_request_id,
    review
  };
}

module.exports = {
  recordReview,
  requestReview,
  importReview,
  loadReview,
  approvedReview,
  buildReviewPrompt,
  parseJsonish
};
