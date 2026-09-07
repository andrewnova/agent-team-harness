const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { types } = require("node:util");
const processes = require("./processes");

const PROTOCOL = "agent-team-sqlite-lock-v1";
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino });
const same = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
const blocked = (lock, reason) => new Error(`${path.basename(lock)} is locked: ${reason}`);

function stat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function databaseIdentity(file) {
  const info = stat(file);
  if (info && (!info.isFile() || info.nlink !== 1)) throw blocked(file, "SQLite mutex must be an unaliased regular file");
  return info && identity(info);
}

function snapshot(lock) {
  const info = stat(lock);
  if (!info) return null;
  if (!info.isDirectory() && !info.isFile()) throw blocked(lock, "unrecognized owner path; inspect ownership before retrying");
  const file = info.isDirectory() ? path.join(lock, "owner.json") : lock;
  const ownerInfo = stat(file);
  if (!ownerInfo?.isFile()) throw blocked(lock, "owner record is missing or aliased; inspect ownership before retrying");
  let raw, owner;
  try { raw = fs.readFileSync(file, "utf8"); owner = JSON.parse(raw); } catch {
    throw blocked(lock, "owner record is unreadable; inspect ownership before retrying");
  }
  return { info, file, ownerInfo, raw, owner };
}

function unchanged(lock, prior) {
  return same(stat(lock), prior.info) && same(stat(prior.file), prior.ownerInfo)
    && fs.readFileSync(prior.file, "utf8") === prior.raw;
}

function retire(lock, database) {
  const prior = snapshot(lock);
  if (!prior) return;
  const owner = prior.owner;
  if (prior.info.isFile()) {
    // A marker is published only inside this exact database's transaction.
    // Obtaining its mutex proves that its previous holder has released it,
    // even if the PID was reused or ps is unavailable. PID is diagnostic only.
    if (owner?.protocol !== PROTOCOL || typeof owner.token !== "string" || !owner.token
        || !same(owner.database, database)) {
      throw blocked(lock, "unrecognized marker or changed SQLite mutex; inspect ownership before retrying");
    }
  } else {
    // Legacy mkdir holders do not participate in SQLite locking. Neither an
    // old timestamp nor a failed process lookup establishes their death.
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1
        || (owner.started !== undefined && (typeof owner.started !== "string" || !owner.started))) {
      throw blocked(lock, "legacy owner identity is incomplete; inspect ownership before retrying");
    }
    let rows;
    try { rows = processes.inventory(); } catch {
      throw blocked(lock, "process inventory is unavailable; legacy ownership remains reserved");
    }
    // An empty/incomplete inventory cannot prove that a PID is absent.
    if (!rows.some((row) => row.pid === process.pid)
        || rows.some((row) => !Number.isSafeInteger(row.pid) || row.pid < 1 || typeof row.started !== "string" || !row.started)) {
      throw blocked(lock, "process inventory is incomplete; legacy ownership remains reserved");
    }
    // Legacy lstart strings have no timezone/boot identity. Even a differing
    // timestamp with a live PID is uncertain (including possible PID reuse).
    if (rows.some((row) => row.pid === owner.pid)) {
      throw blocked(lock, "legacy owner is active or its PID identity is uncertain; retry after it exits");
    }
    if (fs.readdirSync(lock).some((name) => name !== "owner.json")) {
      throw blocked(lock, "legacy directory contains unrecognized files; inspect ownership before retrying");
    }
  }
  if (!unchanged(lock, prior)) throw blocked(lock, "owner changed during inspection; retry");
  // Rename the whole legacy directory; unlinking owner.json first would leave
  // an unrecoverable ownerless directory if this recoverer died before rmdir.
  const retired = `${lock}.${crypto.randomUUID()}.retired`;
  fs.renameSync(lock, retired);
  if (prior.info.isDirectory()) {
    fs.unlinkSync(path.join(retired, "owner.json"));
    fs.rmdirSync(retired);
  } else fs.unlinkSync(retired);
}

function publish(lock, database) {
  const token = crypto.randomUUID();
  const temporary = `${lock}.${token}.tmp`;
  const raw = `${JSON.stringify({ protocol: PROTOCOL, token, pid: process.pid, database })}\n`;
  let linked = false;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, raw);
    fs.fsyncSync(fd);
    const info = fs.fstatSync(fd);
    // link is no-replace and publishes the complete record atomically. A
    // legacy mkdir racing retirement wins safely rather than being removed.
    try { fs.linkSync(temporary, lock); } catch (error) {
      if (error.code === "EEXIST") throw blocked(lock, "another legacy operation acquired ownership; retry");
      throw error;
    }
    linked = true;
    return { info, ownerInfo: info, file: lock, raw };
  } finally {
    fs.closeSync(fd);
    // Failure here leaves a valid recoverable marker, never a partial owner.
    try { fs.unlinkSync(temporary); } catch (error) {
      if (!linked || error.code !== "ENOENT") throw error;
    }
  }
}

/**
 * Run a synchronous critical section, returning its result (or throwing).
 * timeoutMs bounds SQLite contention only; it never expires ownership.
 *
 * The sibling .sqlite file is a permanent mutex inode, not job state. Never
 * unlink/replace it, alias its path, or put it on a filesystem without reliable
 * SQLite locking. SIGKILL releases the transaction in the kernel. The visible
 * marker also excludes old mkdir-based callers. Interrupted staging/retirement
 * may leave harmless UUID .tmp/.retired debris; no job claim is ever changed.
 */
function withLock(lock, fn, { timeoutMs = 1000 } = {}) {
  if (!path.isAbsolute(lock) || path.resolve(lock) !== lock
      || fs.realpathSync(path.dirname(lock)) !== path.dirname(lock)) throw new Error("lock path must have an absolute, canonical parent directory");
  if (typeof fn !== "function" || types.isAsyncFunction(fn)) throw new Error("lock callback must be synchronous");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) throw new Error("lock timeoutMs must be a non-negative 32-bit integer");
  const file = `${lock}.sqlite`;
  const before = databaseIdentity(file);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    const database = databaseIdentity(file);
    if (!database || (before && !same(before, database))) throw blocked(lock, "SQLite mutex identity changed");
    db.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
    try { db.exec("BEGIN IMMEDIATE"); } catch (error) {
      if (error.errcode === 5 || error.errcode === 6) throw blocked(lock, "another operation owns the SQLite mutex; retry");
      throw error;
    }
    if (!same(databaseIdentity(file), database)) throw blocked(lock, "SQLite mutex identity changed");
    retire(lock, database);
    const owned = publish(lock, database);
    try {
      const result = fn();
      if (result && typeof result.then === "function") throw new Error("lock callback must not return a Promise");
      return result;
    } finally {
      if (!same(databaseIdentity(file), database) || !unchanged(lock, owned)) {
        throw blocked(lock, "ownership changed before release; replacement left untouched");
      }
      fs.unlinkSync(lock);
    }
  } finally {
    // Closing rolls back only this connection and releases its kernel lock.
    // Never delete the database to release or recover an operation.
    db.close();
  }
}

module.exports = { withLock };
