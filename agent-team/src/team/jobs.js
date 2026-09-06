const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { readJson, ensureDir } = require("../fsutil");
const mailbox = require("../mailbox");

const ACTIVE = new Set(["launching", "running", "cancelling"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const RUNTIMES = new Set(["codex", "claude"]);
const now = () => new Date().toISOString();

function identifier(value, name = "job id") {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${name} must be a path-safe identifier (letters, digits, _ or -)`);
  }
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function directory(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${name} must be an explicit absolute directory`);
  const real = fs.realpathSync(value);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${name} must be a directory`);
  return real;
}

function location(root, create = false) {
  const cwd = directory(root, "coordinator root");
  let dir = cwd;
  for (const part of [".agent-team", "state", "jobs"]) {
    dir = path.join(dir, part);
    if (create) ensureDir(dir);
    try {
      if (fs.realpathSync(dir) !== dir) throw new Error(`job state must not use symlink aliases: ${dir}`);
    } catch (error) {
      if (error.code !== "ENOENT" || create) throw error;
    }
  }
  return { cwd, dir };
}

// One short root-wide critical section covers capacity, checkout ownership, and
// attempt fencing. A crashed holder fails closed; never steal a live writer lock.
function locked(root, fn) {
  const loc = location(root, true);
  const lock = path.join(path.dirname(loc.dir), "jobs.lock");
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("job state is locked; retry after the current operation (inspect a crashed holder before removing jobs.lock)");
    throw error;
  }
  try {
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, created_at: now() }));
    return fn(loc);
  } finally {
    fs.rmSync(lock, { recursive: true });
  }
}

function load(loc, id) {
  const file = path.join(loc.dir, `${identifier(id)}.json`);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`job record must not be a symlink: ${id}`);
  const job = readJson(file);
  if (job.id !== id) throw new Error(`job record identity mismatch: ${id}`);
  return job;
}

function all(loc) {
  let names;
  try { names = fs.readdirSync(loc.dir); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => name.endsWith(".json")).sort().map((name) => load(loc, name.slice(0, -5)));
}

function save(loc, job) {
  const file = path.join(loc.dir, `${identifier(job.id)}.json`);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(job, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return job;
}

function routeRuntime(leader, role) {
  if (!RUNTIMES.has(leader)) throw new Error("leader must be codex or claude");
  if (role === "backend") return "codex";
  if (role === "frontend") return "claude";
  if (role === "review") return leader === "codex" ? "claude" : "codex";
  if (role === "lead") return leader;
  return null; // Other roles require createJob's explicit runtime.
}

// Subdirectories of one Git checkout share ownership. Plain directories also
// work; realpath plus ancestor overlap prevents symlink/nested writer aliases.
function checkout(cwd) {
  let dir = cwd;
  while (true) {
    try { fs.lstatSync(path.join(dir, ".git")); return dir; } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

function overlaps(a, b) {
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return contains(a, b) || contains(b, a);
}

function createJob(root, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("job input must be an object");
  const id = identifier(input.id ?? `job_${crypto.randomUUID()}`);
  const role = identifier(input.role, "role");
  const routed = routeRuntime(input.leader, role);
  const runtime = input.runtime ?? routed;
  if (!RUNTIMES.has(runtime)) throw new Error("role requires an explicit runtime: codex or claude");
  if (routed && runtime !== routed) throw new Error(`${role} must route to ${routed}`);
  const model = text(input.model, "model (resolve caller configuration before createJob)");
  const cwd = directory(input.cwd, "job cwd");
  if (typeof input.writable !== "boolean") throw new Error("writable must be a boolean");
  const prompt = text(input.prompt, "prompt");
  const dependencies = input.dependencies ?? [];
  if (!Array.isArray(dependencies)) throw new Error("dependencies must be an array");
  dependencies.forEach((dep) => identifier(dep, "dependency"));
  if (new Set(dependencies).size !== dependencies.length || dependencies.includes(id)) throw new Error("dependencies must be unique and cannot include the job itself");
  if (input.feature_id !== undefined) identifier(input.feature_id, "feature_id");
  return locked(root, (loc) => {
    if (fs.existsSync(path.join(loc.dir, `${id}.json`))) throw new Error(`job already exists: ${id}`);
    dependencies.forEach((dep) => load(loc, dep)); // Existing-only edges cannot create cycles.
    return save(loc, {
      id, feature_id: input.feature_id, leader: input.leader, role, runtime, model,
      cwd, checkout: checkout(cwd), writable: input.writable, prompt,
      dependencies: [...dependencies], status: "queued", attempt: 0,
      created_at: now(), updated_at: now()
    });
  });
}

function listJobs(root) { return all(location(root)); }
function getJob(root, id) { return load(location(root), id); }

function current(loc, id, attempt, active = true) {
  const job = load(loc, id);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || job.attempt !== attempt) throw new Error(`stale or invalid job attempt: ${id}/${attempt}`);
  if (active && !ACTIVE.has(job.status)) throw new Error(`job is not active: ${id} (${job.status})`);
  return job;
}

function claimJob(root, id, { max_active } = {}) {
  if (!Number.isSafeInteger(max_active) || max_active < 1) throw new Error("max_active must be a positive integer");
  return locked(root, (loc) => {
    const job = load(loc, id);
    if (job.status !== "queued" && !(["failed", "cancelled"].includes(job.status) && job.process_stopped === true)) throw new Error(`job cannot be claimed: ${id} (${job.status})`);
    for (const dep of job.dependencies) {
      if (load(loc, dep).status !== "completed") throw new Error(`dependency is not completed: ${dep}`);
    }
    if (directory(job.cwd, "job cwd") !== job.cwd || checkout(job.cwd) !== job.checkout) throw new Error(`job checkout identity changed: ${id}`);
    const active = all(loc).filter((other) => ACTIVE.has(other.status));
    if (active.length >= max_active) throw new Error(`job capacity exhausted (max_active=${max_active})`);
    const writer = active.find((other) => job.writable && other.writable && overlaps(job.checkout, other.checkout));
    if (writer) throw new Error(`checkout already has a writer: ${writer.id}`);
    if (job.attempt) {
      job.previous_attempts = [...(job.previous_attempts || []), {
        attempt: job.attempt, status: job.status, result: job.result, reported_result: job.reported_result,
        workspace_id: job.workspace_id, surface_id: job.surface_id, session_id: job.session_id,
        pid: job.pid, process_stopped: job.process_stopped, finished_at: job.finished_at
      }];
    }
    for (const key of ["workspace_id", "surface_id", "session_id", "pid", "result", "reported_result", "ready_at", "finished_at"]) delete job[key];
    return save(loc, { ...job, status: "launching", attempt: job.attempt + 1, process_stopped: false, updated_at: now() });
  });
}

function bindJob(root, id, attempt, input = {}) {
  text(input.workspace_id, "workspace_id");
  text(input.surface_id, "surface_id");
  if (input.ready !== undefined && typeof input.ready !== "boolean") throw new Error("ready must be a boolean");
  if (input.session_id !== undefined) text(input.session_id, "session_id");
  if (input.pid !== undefined && (!Number.isSafeInteger(input.pid) || input.pid < 1)) throw new Error("pid must be a positive integer");
  return locked(root, (loc) => {
    const job = current(loc, id, attempt);
    for (const key of ["workspace_id", "surface_id", "session_id", "pid"]) {
      if (input[key] === undefined) continue;
      if (job[key] !== undefined && job[key] !== input[key]) throw new Error(`job ${key} is already bound for this attempt`);
      job[key] = input[key];
    }
    if (input.ready && job.status !== "cancelling") job.ready_at ||= now();
    if (job.ready_at && job.status !== "cancelling") job.status = "running";
    return save(loc, { ...job, updated_at: now() });
  });
}

function cancelJob(root, id, attempt) {
  return locked(root, (loc) => save(loc, { ...current(loc, id, attempt), status: "cancelling", updated_at: now() }));
}

// Semantic reports never release capacity/checkout ownership. A ready report
// can precede surface binding; running requires both observations.
function reportJob(root, id, attempt, input = {}) {
  if (input.status !== "ready" && !TERMINAL.has(input.status)) throw new Error("report status must be ready, completed, failed or cancelled");
  return locked(root, (loc) => {
    const job = current(loc, id, attempt);
    if (input.status === "ready") {
      if (job.status === "cancelling") throw new Error("cancelling job cannot report readiness");
      job.ready_at ||= now();
      if (job.surface_id && job.workspace_id) job.status = "running";
    } else {
      job.reported_result = { status: input.status, result: input.result ?? null, reported_at: now() };
    }
    return save(loc, { ...job, updated_at: now() });
  });
}

function finishJob(root, id, attempt, input = {}) {
  if (!TERMINAL.has(input.status)) throw new Error("finish status must be completed, failed or cancelled");
  if (input.process_stopped !== true) throw new Error("process_stopped must be true before releasing job ownership");
  return locked(root, (loc) => {
    const job = current(loc, id, attempt, false);
    const result = input.result !== undefined ? input.result : (job.result ?? job.reported_result?.result ?? null);
    if (TERMINAL.has(job.status)) {
      if (job.status === input.status && job.process_stopped === true && isDeepStrictEqual(job.result, result)) return job;
      throw new Error("job already finished with a different outcome");
    }
    if (!ACTIVE.has(job.status)) throw new Error(`job is not active: ${id}`);
    return save(loc, { ...job, status: input.status, result, process_stopped: true, finished_at: now(), updated_at: now() });
  });
}

function messages(loc) {
  if (mailbox.mailboxDiagnostics(loc.cwd).malformed_total) throw new Error("mailbox contains malformed rows; repair before reading or sending job messages");
  return mailbox.listMessages(loc.cwd);
}

function sendJobMessage(root, input = {}) {
  text(input.body, "body");
  return locked(root, (loc) => {
    const from = load(loc, input.from_job);
    current(loc, from.id, input.from_attempt ?? from.attempt);
    const to = load(loc, input.to_job);
    current(loc, to.id, to.attempt);
    const rows = messages(loc);
    const kind = input.kind ?? (input.in_reply_to ? "reply" : "request");
    if (!["request", "reply", "notify", "checkin"].includes(kind)) throw new Error("job message kind must be request, reply, notify or checkin");
    if ((kind === "reply") !== Boolean(input.in_reply_to)) throw new Error("reply requires in_reply_to; only replies can set it");
    let original;
    if (input.in_reply_to) {
      original = rows.find((row) => {
        const meta = row.metadata;
        return (row.id === input.in_reply_to || row.request_id === input.in_reply_to)
          && meta?.to_job === from.id && meta.to_attempt === from.attempt
          && meta.from_job === to.id && meta.from_attempt === to.attempt;
      });
      if (!original) throw new Error("reply must reference a message addressed between these current job attempts");
    }
    const id = `jobmsg_${crypto.randomUUID()}`;
    return mailbox.appendMessage(loc.cwd, {
      id, from: from.runtime, to: to.runtime, body: input.body, kind,
      request_id: original?.request_id || original?.id || id,
      in_reply_to: original?.id, reply_required: kind === "request",
      metadata: { from_job: from.id, from_attempt: from.attempt, to_job: to.id, to_attempt: to.attempt }
    }).message;
  });
}

function jobInbox(root, id, attempt) {
  return locked(root, (loc) => {
    const job = current(loc, id, attempt);
    return messages(loc).filter((message) => {
      const meta = message.metadata;
      if (!meta || meta.to_job !== id || meta.to_attempt !== attempt || message.to !== job.runtime) return false;
      const sender = load(loc, meta.from_job);
      return sender.attempt === meta.from_attempt && message.from === sender.runtime;
    }).map((message) => {
      // Existing loadMessage tolerates missing body files; this addressed API
      // must fail visibly instead of turning a lost result into an empty reply.
      if (message.body_path) fs.accessSync(path.resolve(loc.cwd, message.body_path), fs.constants.R_OK);
      return mailbox.loadMessage(loc.cwd, message.id, { include_body: true });
    });
  });
}

module.exports = {
  routeRuntime, createJob, listJobs, getJob, claimJob, bindJob, cancelJob,
  reportJob, finishJob, sendJobMessage, jobInbox
};
