const fs = require("node:fs");
const path = require("node:path");
const paths = require("./paths");
const { ensureDir, exists, readJson, readJsonl } = require("./fsutil");

const SCHEMA_VERSION = 2;
let DatabaseSyncConstructor;

function now() {
  return new Date().toISOString();
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function nullable(value) {
  return value === undefined ? null : value;
}

function loadDatabaseSync() {
  if (DatabaseSyncConstructor) return DatabaseSyncConstructor;
  try {
    ({ DatabaseSync: DatabaseSyncConstructor } = require("node:sqlite"));
  } catch (error) {
    throw new Error(`agent-team SQLite state requires Node.js >=22.13.0 with node:sqlite support: ${error.message}`);
  }
  if (!DatabaseSyncConstructor) throw new Error("agent-team SQLite state requires node:sqlite DatabaseSync support");
  return DatabaseSyncConstructor;
}

function openDatabase(cwd) {
  ensureDir(path.dirname(paths.dbPath(cwd)));
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(paths.dbPath(cwd));
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  return db;
}

function withDatabase(cwd, fn) {
  const db = openDatabase(cwd);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch (_rollbackError) {
      // Keep the original error. Rollback can fail if SQLite already unwound.
    }
    throw error;
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goals (
      goal_id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT,
      objective TEXT,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      goal_id TEXT,
      title TEXT,
      status TEXT,
      owner TEXT,
      reviewer TEXT,
      facet TEXT,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      kind TEXT,
      title TEXT,
      status TEXT,
      goal_id TEXT,
      task_id TEXT,
      owner TEXT,
      mode TEXT,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      recorded_at TEXT NOT NULL,
      type TEXT NOT NULL,
      goal_id TEXT,
      task_id TEXT,
      actor TEXT,
      owner TEXT,
      reviewer TEXT,
      status TEXT,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attempts (
      task_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      owner TEXT,
      result TEXT,
      recorded_at TEXT,
      json TEXT NOT NULL,
      PRIMARY KEY (task_id, attempt)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      task_id TEXT NOT NULL,
      reviewer TEXT NOT NULL,
      owner TEXT,
      verdict TEXT,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (task_id, reviewer)
    );

    CREATE TABLE IF NOT EXISTS proof (
      task_id TEXT PRIMARY KEY,
      verdict TEXT,
      tree_hash TEXT,
      merge_ref TEXT,
      source_digest TEXT,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leases (
      lease_id TEXT PRIMARY KEY,
      task_id TEXT,
      goal_id TEXT,
      owner TEXT,
      mode TEXT,
      status TEXT,
      paths_json TEXT,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worktrees (
      task_id TEXT PRIMARY KEY,
      goal_id TEXT,
      owner TEXT,
      reviewer TEXT,
      branch TEXT,
      status TEXT,
      worktree_path TEXT,
      snapshot_commit TEXT,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS merges (
      task_id TEXT PRIMARY KEY,
      strategy TEXT,
      merge_ref TEXT,
      tree_hash TEXT,
      source_digest TEXT,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plans (
      goal_id TEXT NOT NULL,
      author TEXT NOT NULL,
      path TEXT,
      body TEXT,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (goal_id, author)
    );

    CREATE TABLE IF NOT EXISTS regrounds (
      task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      source TEXT,
      faithful INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (task_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS advisory (
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      task_id TEXT,
      goal_id TEXT,
      verdict TEXT,
      updated_at TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (kind, record_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_goal_status ON tasks(goal_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON tasks(owner, status);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_kind_status ON runs(kind, status);
    CREATE INDEX IF NOT EXISTS idx_runs_task_status ON runs(task_id, status);
    CREATE INDEX IF NOT EXISTS idx_runs_goal_status ON runs(goal_id, status);
    CREATE INDEX IF NOT EXISTS idx_events_task_recorded ON events(task_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_events_goal_recorded ON events(goal_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_leases_task_status ON leases(task_id, status);
    CREATE INDEX IF NOT EXISTS idx_advisory_task_kind ON advisory(task_id, kind);
  `);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
}

function rebuildMarkerPath(cwd) {
  return path.join(paths.stateDir(cwd), "agent-team.sqlite.rebuild-required.json");
}

function markRebuildRequired(cwd, error) {
  ensureDir(paths.stateDir(cwd));
  fs.writeFileSync(
    rebuildMarkerPath(cwd),
    `${JSON.stringify(
      {
        required: true,
        reason: error.message,
        recorded_at: now()
      },
      null,
      2
    )}\n`
  );
}

function clearRebuildRequired(cwd) {
  fs.rmSync(rebuildMarkerPath(cwd), { force: true });
}

function writeThrough(cwd, fn) {
  try {
    return withDatabase(cwd, fn);
  } catch (error) {
    markRebuildRequired(cwd, error);
    throw error;
  }
}

function countJson(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
}

function countJsonlRows(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".jsonl")).sort()) {
    count += readJsonl(path.join(dir, name)).length;
  }
  return count;
}

function countAttemptMirrors(cwd) {
  const dir = path.join(paths.stateDir(cwd), "attempts");
  if (!fs.existsSync(dir)) return 0;
  const uniqueKeys = new Set();
  let malformedPrimaryKeys = 0;
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".jsonl")).sort()) {
    for (const attempt of readJsonl(path.join(dir, name))) {
      if (attempt && attempt.task_id && attempt.attempt !== undefined && attempt.attempt !== null) {
        uniqueKeys.add(`${attempt.task_id}\0${attempt.attempt}`);
      } else {
        malformedPrimaryKeys += 1;
      }
    }
  }
  return uniqueKeys.size + malformedPrimaryKeys;
}

function countProofMirrors(cwd) {
  const proofRoot = path.join(paths.stateDir(cwd), "proof");
  if (!fs.existsSync(proofRoot)) return 0;
  let count = 0;
  for (const taskId of fs.readdirSync(proofRoot)) {
    if (exists(path.join(proofRoot, taskId, "manifest.json"))) count += 1;
  }
  return count;
}

function countPlanMirrors(cwd) {
  const plansRoot = path.join(paths.stateDir(cwd), "plans");
  if (!fs.existsSync(plansRoot)) return 0;
  let count = 0;
  for (const goalId of fs.readdirSync(plansRoot)) {
    const goalDir = path.join(plansRoot, goalId);
    if (!fs.statSync(goalDir).isDirectory()) continue;
    count += ["codex", "claude", "reconciled"].filter((author) => exists(path.join(goalDir, `${author}.md`))).length;
  }
  return count;
}

function countAdvisoryMirrors(cwd) {
  const advisoryRoot = path.join(paths.stateDir(cwd), "advisory");
  if (!fs.existsSync(advisoryRoot)) return 0;
  let count = 0;
  for (const kind of fs.readdirSync(advisoryRoot)) {
    const dir = path.join(advisoryRoot, kind);
    if (!fs.statSync(dir).isDirectory()) continue;
    count += fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  }
  return count;
}

function mirrorCounts(cwd) {
  const leaseBook = exists(paths.leasesPath(cwd)) ? readJson(paths.leasesPath(cwd)) : { leases: [] };
  return {
    goals: countJson(path.join(paths.stateDir(cwd), "goals")),
    tasks: countJson(path.join(paths.stateDir(cwd), "tasks")),
    runs: countJson(path.join(paths.stateDir(cwd), "runs")),
    events: readJsonl(paths.eventsPath(cwd)).length,
    attempts: countAttemptMirrors(cwd),
    reviews: countJson(path.join(paths.stateDir(cwd), "reviews")),
    proof: countProofMirrors(cwd),
    leases: Array.isArray(leaseBook.leases) ? leaseBook.leases.length : 0,
    worktrees: countJson(path.join(paths.stateDir(cwd), "worktrees")),
    merges: countJson(path.join(paths.stateDir(cwd), "merges")),
    plans: countPlanMirrors(cwd),
    regrounds: countJson(path.join(paths.stateDir(cwd), "regrounds")),
    advisory: countAdvisoryMirrors(cwd)
  };
}

function rebuildAssessment(db, cwd) {
  const counts = tableCounts(db);
  const mirror_counts = mirrorCounts(cwd);
  const mismatches = Object.entries(mirror_counts)
    .filter(([table, count]) => counts[table] !== count)
    .map(([table, count]) => ({
      table,
      sqlite: counts[table],
      mirrors: count
    }));
  const marker = exists(rebuildMarkerPath(cwd)) ? readJson(rebuildMarkerPath(cwd)) : null;
  return {
    counts,
    mirror_counts,
    needs_rebuild: mismatches.length > 0 || Boolean(marker),
    rebuild_reasons: mismatches,
    rebuild_marker: marker
  };
}

function initDatabase(cwd) {
  const initialized = withDatabase(cwd, (db) => ({
    ok: true,
    path: paths.dbPath(cwd),
    schema_version: SCHEMA_VERSION,
    ...rebuildAssessment(db, cwd)
  }));
  if (initialized.needs_rebuild) return rebuildDatabase(cwd);
  return initialized;
}

function writeGoal(db, goal) {
  db.prepare(
    `INSERT OR REPLACE INTO goals (goal_id, title, status, objective, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(goal.goal_id, goal.title, goal.status, goal.objective, now(), json(goal));
}

function upsertGoal(cwd, goal) {
  return writeThrough(cwd, (db) => {
    writeGoal(db, goal);
    return goal;
  });
}

function writeTask(db, task) {
  db.prepare(
    `INSERT OR REPLACE INTO tasks (task_id, goal_id, title, status, owner, reviewer, facet, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(task.task_id, task.goal_id, task.title, task.status, task.owner, task.reviewer, task.facet, now(), json(task));
}

function upsertTask(cwd, task) {
  return writeThrough(cwd, (db) => {
    writeTask(db, task);
    return task;
  });
}

function writeRun(db, run) {
  db.prepare(
    `INSERT OR REPLACE INTO runs (run_id, kind, title, status, goal_id, task_id, owner, mode, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    run.run_id,
    nullable(run.kind),
    nullable(run.title),
    nullable(run.status),
    nullable(run.goal_id),
    nullable(run.task_id),
    nullable(run.owner),
    nullable(run.mode),
    run.updated_at || run.completed_at || run.started_at || now(),
    json(run)
  );
}

function upsertRun(cwd, run) {
  return writeThrough(cwd, (db) => {
    writeRun(db, run);
    return run;
  });
}

function writeEvent(db, event) {
  db.prepare(
    `INSERT OR REPLACE INTO events (event_id, recorded_at, type, goal_id, task_id, actor, owner, reviewer, status, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.event_id,
    event.recorded_at,
    event.type,
    nullable(event.goal_id),
    nullable(event.task_id),
    nullable(event.actor),
    nullable(event.owner),
    nullable(event.reviewer),
    nullable(event.status),
    json(event)
  );
}

function insertEvent(cwd, event) {
  return writeThrough(cwd, (db) => {
    writeEvent(db, event);
    return event;
  });
}

function writeAttempt(db, attempt) {
  db.prepare(
    `INSERT OR REPLACE INTO attempts (task_id, attempt, owner, result, recorded_at, json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(attempt.task_id, attempt.attempt, nullable(attempt.owner), nullable(attempt.result), nullable(attempt.recorded_at), json(attempt));
}

function upsertAttempt(cwd, attempt) {
  return writeThrough(cwd, (db) => {
    writeAttempt(db, attempt);
    return attempt;
  });
}

function writeReview(db, review) {
  db.prepare(
    `INSERT OR REPLACE INTO reviews (task_id, reviewer, owner, verdict, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(review.task_id, review.reviewer, nullable(review.owner), nullable(review.verdict), review.recorded_at || now(), json(review));
}

function upsertReview(cwd, review) {
  return writeThrough(cwd, (db) => {
    writeReview(db, review);
    return review;
  });
}

function writeProof(db, manifest) {
  db.prepare(
    `INSERT OR REPLACE INTO proof (task_id, verdict, tree_hash, merge_ref, source_digest, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    manifest.task_id,
    nullable(manifest.verdict),
    nullable(manifest.tree_hash),
    nullable(manifest.merge_ref),
    nullable(manifest.source_digest),
    now(),
    json(manifest)
  );
}

function upsertProof(cwd, manifest) {
  return writeThrough(cwd, (db) => {
    writeProof(db, manifest);
    return manifest;
  });
}

function writeLeaseBook(db, book) {
  db.prepare("DELETE FROM leases").run();
  const insert = db.prepare(
    `INSERT INTO leases (lease_id, task_id, goal_id, owner, mode, status, paths_json, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const lease of book.leases || []) {
    insert.run(
      lease.lease_id,
      nullable(lease.task_id),
      nullable(lease.goal_id),
      nullable(lease.owner),
      nullable(lease.mode),
      nullable(lease.status),
      json(lease.paths || []),
      lease.released_at || lease.escalated_at || lease.claimed_at || now(),
      json(lease)
    );
  }
}

function syncLeaseBook(cwd, book) {
  return writeThrough(cwd, (db) => {
    tx(db, () => writeLeaseBook(db, book));
    return book;
  });
}

function writeWorktree(db, record) {
  db.prepare(
    `INSERT OR REPLACE INTO worktrees (task_id, goal_id, owner, reviewer, branch, status, worktree_path, snapshot_commit, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.task_id,
    nullable(record.goal_id),
    nullable(record.owner),
    nullable(record.reviewer),
    nullable(record.branch),
    nullable(record.status),
    nullable(record.worktree_path),
    nullable(record.snapshot_commit),
    record.merged_at || record.snapshotted_at || record.created_at || now(),
    json(record)
  );
}

function upsertWorktree(cwd, record) {
  return writeThrough(cwd, (db) => {
    writeWorktree(db, record);
    return record;
  });
}

function writeMerge(db, record) {
  db.prepare(
    `INSERT OR REPLACE INTO merges (task_id, strategy, merge_ref, tree_hash, source_digest, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.task_id,
    nullable(record.strategy),
    nullable(record.merge_ref),
    nullable(record.tree_hash),
    nullable(record.source_digest),
    record.recorded_at || now(),
    json(record)
  );
}

function upsertMerge(cwd, record) {
  return writeThrough(cwd, (db) => {
    writeMerge(db, record);
    return record;
  });
}

function writePlan(db, plan) {
  db.prepare(
    `INSERT OR REPLACE INTO plans (goal_id, author, path, body, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(plan.goal_id, plan.author, nullable(plan.path), nullable(plan.body), plan.recorded_at || now(), json(plan));
}

function upsertPlan(cwd, plan) {
  return writeThrough(cwd, (db) => {
    writePlan(db, plan);
    return plan;
  });
}

function writeReground(db, taskId, sequence, record) {
  db.prepare(
    `INSERT OR REPLACE INTO regrounds (task_id, sequence, source, faithful, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(taskId, sequence, nullable(record.source), 1, record.stored_at || now(), json(record));
}

function upsertReground(cwd, taskId, sequence, record) {
  return writeThrough(cwd, (db) => {
    writeReground(db, taskId, sequence, record);
    return record;
  });
}

function advisoryTaskId(record, options) {
  if (options.task_id !== undefined) return options.task_id;
  if (record.task_id !== undefined) return record.task_id;
  if (record.scope === "task") return record.subject_id;
  return undefined;
}

function advisoryGoalId(record, options) {
  if (options.goal_id !== undefined) return options.goal_id;
  if (record.goal_id !== undefined) return record.goal_id;
  if (record.scope === "goal") return record.subject_id;
  return undefined;
}

function inferTaskGoalId(cwd, taskId) {
  if (!taskId) return undefined;
  const file = paths.taskPath(cwd, taskId);
  if (!exists(file)) return undefined;
  return readJson(file).goal_id;
}

function inferAdvisoryOptions(cwd, record) {
  const task_id = advisoryTaskId(record, {});
  const goal_id = advisoryGoalId(record, {}) || inferTaskGoalId(cwd, task_id);
  return { task_id, goal_id };
}

function writeAdvisory(db, kind, recordId, record, options = {}) {
  db.prepare(
    `INSERT OR REPLACE INTO advisory (kind, record_id, task_id, goal_id, verdict, updated_at, json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    kind,
    recordId,
    nullable(advisoryTaskId(record, options)),
    nullable(advisoryGoalId(record, options)),
    nullable(options.verdict || record.verdict || record.synthesis?.decision),
    record.recorded_at || record.imported_at || now(),
    json(record)
  );
}

function upsertAdvisory(cwd, kind, recordId, record, options = {}) {
  return writeThrough(cwd, (db) => {
    writeAdvisory(db, kind, recordId, record, options);
    return record;
  });
}

function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(dir, name)));
}

function rebuildDatabase(cwd) {
  const result = withDatabase(cwd, (db) =>
    tx(db, () => {
      for (const table of ["goals", "tasks", "runs", "events", "attempts", "reviews", "proof", "leases", "worktrees", "merges", "plans", "regrounds", "advisory"]) {
        db.prepare(`DELETE FROM ${table}`).run();
      }

      for (const goal of listJson(path.join(paths.stateDir(cwd), "goals"))) writeGoal(db, goal);
      for (const task of listJson(path.join(paths.stateDir(cwd), "tasks"))) writeTask(db, task);
      for (const run of listJson(path.join(paths.stateDir(cwd), "runs"))) writeRun(db, run);
      for (const event of readJsonl(paths.eventsPath(cwd))) writeEvent(db, event);

      const attemptsDir = path.join(paths.stateDir(cwd), "attempts");
      if (fs.existsSync(attemptsDir)) {
        for (const name of fs.readdirSync(attemptsDir).filter((item) => item.endsWith(".jsonl")).sort()) {
          for (const attempt of readJsonl(path.join(attemptsDir, name))) writeAttempt(db, attempt);
        }
      }

      for (const review of listJson(path.join(paths.stateDir(cwd), "reviews"))) writeReview(db, review);

      const proofRoot = path.join(paths.stateDir(cwd), "proof");
      if (fs.existsSync(proofRoot)) {
        for (const taskId of fs.readdirSync(proofRoot).sort()) {
          const file = path.join(proofRoot, taskId, "manifest.json");
          if (exists(file)) writeProof(db, readJson(file));
        }
      }

      if (exists(paths.leasesPath(cwd))) writeLeaseBook(db, readJson(paths.leasesPath(cwd)));
      for (const worktree of listJson(path.join(paths.stateDir(cwd), "worktrees"))) writeWorktree(db, worktree);
      for (const merge of listJson(path.join(paths.stateDir(cwd), "merges"))) writeMerge(db, merge);

      const plansRoot = path.join(paths.stateDir(cwd), "plans");
      if (fs.existsSync(plansRoot)) {
        for (const goalId of fs.readdirSync(plansRoot).sort()) {
          const goalDir = path.join(plansRoot, goalId);
          if (!fs.statSync(goalDir).isDirectory()) continue;
          for (const author of ["codex", "claude", "reconciled"]) {
            const file = path.join(goalDir, `${author}.md`);
            if (exists(file)) {
              writePlan(db, {
                goal_id: goalId,
                author,
                path: file,
                body: fs.readFileSync(file, "utf8")
              });
            }
          }
        }
      }

      const regroundDir = path.join(paths.stateDir(cwd), "regrounds");
      if (fs.existsSync(regroundDir)) {
        for (const name of fs.readdirSync(regroundDir).filter((item) => item.endsWith(".json")).sort()) {
          const match = name.match(/^(T-\d+)-(\d+)\.json$/);
          if (match) writeReground(db, match[1], Number(match[2]), readJson(path.join(regroundDir, name)));
        }
      }

      const advisoryRoot = path.join(paths.stateDir(cwd), "advisory");
      if (fs.existsSync(advisoryRoot)) {
        for (const kind of fs.readdirSync(advisoryRoot).sort()) {
          const dir = path.join(advisoryRoot, kind);
          if (!fs.statSync(dir).isDirectory()) continue;
          for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".json")).sort()) {
            const record = readJson(path.join(dir, name));
            writeAdvisory(db, kind, name.replace(/\.json$/, ""), record, inferAdvisoryOptions(cwd, record));
          }
        }
      }

      return {
        ok: true,
        path: paths.dbPath(cwd),
        schema_version: SCHEMA_VERSION,
        counts: tableCounts(db)
      };
    })
  );
  clearRebuildRequired(cwd);
  return result;
}

function tableCounts(db) {
  const tables = ["goals", "tasks", "runs", "events", "attempts", "reviews", "proof", "leases", "worktrees", "merges", "plans", "regrounds", "advisory"];
  const counts = {};
  for (const table of tables) counts[table] = db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
  return counts;
}

function status(cwd) {
  return withDatabase(cwd, (db) => {
    const assessment = rebuildAssessment(db, cwd);
    return {
      ok: true,
      path: paths.dbPath(cwd),
      schema_version: Number(db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version").value),
      ...assessment
    };
  });
}

function query(cwd, sql) {
  const normalized = String(sql || "").trim();
  if (!/^select\b/i.test(normalized)) throw new Error("db query only allows SELECT statements");
  if (/;\s*\S/.test(normalized)) throw new Error("db query accepts one SELECT statement at a time");
  return withDatabase(cwd, (db) => ({
    ok: true,
    rows: db.prepare(normalized).all()
  }));
}

module.exports = {
  SCHEMA_VERSION,
  initDatabase,
  upsertGoal,
  upsertTask,
  upsertRun,
  insertEvent,
  upsertAttempt,
  upsertReview,
  upsertProof,
  syncLeaseBook,
  upsertWorktree,
  upsertMerge,
  upsertPlan,
  upsertReground,
  upsertAdvisory,
  rebuildDatabase,
  status,
  query
};
