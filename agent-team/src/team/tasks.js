// Operator submissions share the jobs critical section. They are durable inbox
// entries, without inventing a sender job or borrowing the lead's identity.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicJson } = require("./atomicJson");

function validate(id, body) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error("task id must be a path-safe identifier");
  if (typeof body !== "string" || !body.trim() || body.includes("\0")) throw new Error("task body must be a non-empty string without NUL");
}

function directory(root) {
  const dir = path.join(root, ".agent-team", "state", "tasks");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(dir) !== dir) throw new Error("task state must not use symlink aliases");
  return dir;
}

function file(root, id) {
  validate(id, "record");
  return path.join(directory(root), `${id}.json`);
}

function read(root, id) {
  const target = file(root, id);
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error("task record must not be a symlink");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const task = JSON.parse(fs.readFileSync(target, "utf8"));
  validate(task.id, task.body);
  if (task.id !== id || task.body_sha256 !== crypto.createHash("sha256").update(task.body).digest("hex")) throw new Error("task record identity or body hash mismatch");
  return task;
}

function save(root, task) {
  return atomicJson(file(root, task.id), task);
}

function submit(root, { id, body }) {
  validate(id, body);
  const existing = read(root, id);
  if (existing) {
    if (existing.body !== body) throw new Error("task id already contains different content; use a new task id");
    return existing;
  }
  return save(root, { id, body, body_sha256: crypto.createHash("sha256").update(body).digest("hex"),
    status: "submitted", created_at: new Date().toISOString(), deliveries: [] });
}

function assign(root, id, job, { resume = false } = {}) {
  const task = read(root, id);
  if (!task) throw new Error("unknown task id");
  if (task.status === "completed") return { task, state: "completed" };
  const attempt = job.status === "queued" ? job.attempt + 1 : job.attempt;
  if (job.role !== "lead") throw new Error("task recipient must be a lead");
  if (!["queued", "launching", "running"].includes(job.status) || job.reported_result) return { task, state: "recipient_unavailable" };
  const previous = task.deliveries.at(-1);
  if (previous && (previous.job_id !== job.id || previous.attempt !== attempt)) {
    if (!resume) return { task, state: "resume_required" };
  } else if (previous) return { task, state: task.status };
  task.deliveries.push({ job_id: job.id, attempt, runtime: job.runtime,
    message_id: `task_${task.id}_${job.id}_${attempt}`, assigned_at: new Date().toISOString(), replies: [] });
  task.status = "submitted";
  return { task: save(root, task), state: "submitted" };
}

function list(root) {
  return fs.readdirSync(directory(root)).filter((name) => name.endsWith(".json")).sort().map((name) => read(root, name.slice(0, -5)));
}

function inbox(root, job, { includeCompleted = false } = {}) {
  return list(root).flatMap((task) => {
    const delivery = task.deliveries.at(-1);
    if ((!includeCompleted && task.status === "completed") || delivery?.job_id !== job.id || delivery.attempt !== job.attempt) return [];
    return [{ id: delivery.message_id, request_id: delivery.message_id, from: "human", to: job.runtime, kind: "request",
      body: task.body, task_id: task.id, task_status: task.status, reply_required: task.status === "submitted",
      previous_deliveries: task.deliveries.slice(0, -1), replies: delivery.replies,
      metadata: { origin: "operator_task", to_job: job.id, to_attempt: job.attempt } }];
  });
}

function reply(root, job, { in_reply_to, body, task_status = "acknowledged" }) {
  const message = inbox(root, job, { includeCompleted: true }).find((row) => row.id === in_reply_to);
  if (!message) throw new Error("operator task is not in this job's current inbox");
  if (!["acknowledged", "completed"].includes(task_status)) throw new Error("invalid operator task status");
  if (typeof body !== "string" || !body.trim() || body.includes("\0")) throw new Error("task reply body must be a non-empty string");
  const task = read(root, message.task_id);
  const delivery = task.deliveries.at(-1);
  const duplicate = delivery.replies.find((row) => row.status === task_status && row.body === body);
  if (task.status === "completed" && !duplicate) throw new Error("completed operator task cannot be changed or reopened");
  if (!duplicate) delivery.replies.push({ status: task_status, body, created_at: new Date().toISOString() });
  if (!duplicate) task.status = task_status;
  if (!duplicate) save(root, task);
  return { task_id: task.id, status: task.status, in_reply_to, idempotent: Boolean(duplicate) };
}

function summary(root, result) {
  return { id: result.task.id, body_sha256: result.task.body_sha256, state: result.state,
    record_path: file(root, result.task.id), delivery: result.task.deliveries.at(-1) || null };
}

module.exports = { validate, read, list, submit, assign, inbox, reply, summary };
