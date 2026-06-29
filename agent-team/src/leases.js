const crypto = require("node:crypto");
const paths = require("./paths");
const { exists, readJson, writeJson } = require("./fsutil");
const { recordEvent } = require("./state");
const db = require("./db");

function loadLeaseBook(cwd) {
  const file = paths.leasesPath(cwd);
  if (!exists(file)) return { version: 1, leases: [] };
  const book = readJson(file);
  return {
    version: book.version || 1,
    leases: Array.isArray(book.leases) ? book.leases : []
  };
}

function saveLeaseBook(cwd, book) {
  const normalized = {
    version: 1,
    leases: book.leases || []
  };
  writeJson(paths.leasesPath(cwd), normalized);
  db.syncLeaseBook(cwd, normalized);
  return normalized;
}

function normalizePaths(values) {
  const paths = (values || []).map((value) => String(value || "").trim()).filter(Boolean);
  return paths.length ? [...new Set(paths)] : ["*"];
}

function leaseBase(pattern) {
  const normalized = String(pattern || "*").replace(/\\/g, "/");
  if (normalized === "*" || normalized === "**" || normalized === "**/*") return "*";
  const wildcard = normalized.search(/[*?\[]/);
  const base = wildcard === -1 ? normalized : normalized.slice(0, wildcard);
  return base.replace(/\/+$/, "");
}

function pathsOverlap(left, right) {
  const a = leaseBase(left);
  const b = leaseBase(right);
  if (a === "*" || b === "*") return true;
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function activeLeases(cwd) {
  return loadLeaseBook(cwd).leases.filter((lease) => lease.status === "active");
}

function leaseConflicts(cwd, task, requestedPaths) {
  return activeLeases(cwd).filter((lease) => {
    if (lease.task_id === task.task_id) return false;
    if (lease.mode !== "exclusive") return false;
    return (lease.paths || []).some((held) => requestedPaths.some((requested) => pathsOverlap(held, requested)));
  });
}

function claimLeasesForTask(cwd, task, options = {}) {
  const book = loadLeaseBook(cwd);
  const existing = book.leases.filter((lease) => lease.task_id === task.task_id && lease.status === "active");
  if (existing.length) {
    return { ok: true, action: "already_claimed", leases: existing };
  }
  const requestedPaths = normalizePaths(options.paths || task.allowed_paths);
  const conflicts = leaseConflicts(cwd, task, requestedPaths);
  if (conflicts.length) {
    return {
      ok: false,
      action: "lease_conflict",
      requested: {
        task_id: task.task_id,
        owner: task.owner,
        paths: requestedPaths
      },
      conflicts
    };
  }
  const lease = {
    lease_id: `lease_${crypto.randomUUID()}`,
    task_id: task.task_id,
    goal_id: task.goal_id,
    owner: task.owner,
    mode: options.mode || "exclusive",
    paths: requestedPaths,
    status: "active",
    claimed_at: new Date().toISOString(),
    reason: options.reason || "task claimed"
  };
  book.leases.push(lease);
  saveLeaseBook(cwd, book);
  recordEvent(cwd, {
    type: "lease.claimed",
    goal_id: task.goal_id,
    task_id: task.task_id,
    owner: task.owner,
    status: task.status,
    detail: {
      lease_id: lease.lease_id,
      paths: lease.paths,
      mode: lease.mode
    }
  });
  return { ok: true, action: "claimed", leases: [lease] };
}

function releaseLeases(cwd, taskId, reason = "released") {
  const book = loadLeaseBook(cwd);
  const released = [];
  for (const lease of book.leases) {
    if (lease.task_id === taskId && lease.status === "active") {
      lease.status = "released";
      lease.released_at = new Date().toISOString();
      lease.release_reason = reason;
      released.push(lease);
    }
  }
  saveLeaseBook(cwd, book);
  if (released.length) {
    recordEvent(cwd, {
      type: "lease.released",
      task_id: taskId,
      detail: {
        reason,
        leases: released.map((lease) => lease.lease_id)
      }
    });
  }
  return { ok: true, released };
}

function escalateLease(cwd, leaseId, reason = "manual escalation") {
  const book = loadLeaseBook(cwd);
  const lease = book.leases.find((row) => row.lease_id === leaseId);
  if (!lease) return { ok: false, error: `lease not found: ${leaseId}` };
  lease.status = "escalated";
  lease.escalated_at = new Date().toISOString();
  lease.escalation_reason = reason;
  saveLeaseBook(cwd, book);
  recordEvent(cwd, {
    type: "lease.escalated",
    goal_id: lease.goal_id,
    task_id: lease.task_id,
    owner: lease.owner,
    detail: {
      lease_id: lease.lease_id,
      reason
    }
  });
  return { ok: true, lease };
}

module.exports = {
  loadLeaseBook,
  saveLeaseBook,
  activeLeases,
  claimLeasesForTask,
  releaseLeases,
  escalateLease,
  leaseBase,
  pathsOverlap
};
