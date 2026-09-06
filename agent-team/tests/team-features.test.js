const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { tempRoot } = require("./helpers");
const features = require("../src/team/features");

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeCommit(cwd, file, content) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", "--", file);
  git(cwd, "commit", "-m", `Fixture for ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

function fixture(t, overrides = {}) {
  const temporary = fs.realpathSync(tempRoot());
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "coordinator");
  const repo = path.join(temporary, "repo");
  fs.mkdirSync(root);
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.test");
  writeCommit(repo, "src/api.js", "module.exports = 'base';\n");
  const input = {
    id: "feature-api", repo, brief: "Implement the API with review and test evidence.", leader: "codex",
    review_jobs: ["review-security", "review-correctness"],
    checks: [{ id: "unit", command: [process.execPath, "-e", "console.log('checked'); console.error('diagnostic')"] }],
    ...overrides
  };
  const feature = features.createFeature(root, input);
  const worker = path.join(temporary, "worker");
  git(repo, "worktree", "add", "-b", "codex/worker", worker, feature.base);
  const update = (change) => {
    const file = path.join(root, ".agent-team", "state", "features", `${feature.id}.json`);
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    change(current);
    fs.writeFileSync(file, JSON.stringify(current));
  };
  return { temporary, root, repo, worker, feature, input, update };
}

function assemble(f, file = "src/api.js", content = "module.exports = 'new';\n") {
  const commit = writeCommit(f.worker, file, content);
  return features.assembleFeature(f.root, f.feature.id, { commit, worker_cwd: f.worker, allowed_paths: ["src/**"] });
}

function review(f, reviewer, overrides = {}) {
  const { candidate } = features.getFeature(f.root, f.feature.id);
  return features.recordFeatureReview(f.root, f.feature.id, {
    reviewer_job_id: reviewer, candidate, brief_hash: candidate.brief_hash, verdict: "approve", findings: [], ...overrides
  });
}

function approveAll(f) {
  for (const job of f.input.review_jobs) review(f, job);
}

test("feature assembly freezes committed source and requires every review and check", (t) => {
  const f = fixture(t);
  assert.equal(f.feature.repo, fs.realpathSync(f.repo));
  assert.match(f.feature.branch, /^codex\//);
  assert.equal(f.feature.candidate, null);
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
  assert.throws(() => features.recordFeatureReview(f.root, f.feature.id, {}), /frozen candidate/);
  const assembled = assemble(f);
  assert.equal(assembled.assemblies.length, 1);
  assert.equal(fs.readFileSync(path.join(f.repo, "src/api.js"), "utf8"), "module.exports = 'base';\n");
  const snapshot = features.snapshotFeature(f.root, f.feature.id);
  assert.equal(snapshot.candidate.commit, git(snapshot.cwd, "rev-parse", "HEAD"));
  assert.equal(snapshot.candidate.tree, git(snapshot.cwd, "rev-parse", "HEAD^{tree}"));
  assert.equal(snapshot.candidate.generation, 1);
  review(f, "review-security");
  assert.match(features.featureStatus(f.root, f.feature.id).reasons.join("\n"), /missing review: review-correctness/);
  const run = features.runFeatureChecks(f.root, f.feature.id);
  assert.equal(run.source_unchanged, true);
  assert.equal(run.results[0].exit_code, 0);
  assert.equal(fs.readFileSync(run.results[0].stdout_path, "utf8"), "checked\n");
  assert.equal(fs.readFileSync(run.results[0].stderr_path, "utf8"), "diagnostic\n");
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
  review(f, "review-correctness");
  assert.deepEqual(features.featureStatus(f.root, f.feature.id).reasons, []);
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, true);
  assert.equal(features.snapshotFeature(f.root, f.feature.id).generation, 1);
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, true);
  assert.throws(() => features.createFeature(f.root, f.input), /already exists/);
  const worktrees = git(f.repo, "worktree", "list", "--porcelain");
  assert.equal(worktrees.includes("agent-team-feature-check-"), false);
});

test("snapshots and acceptance reject dirty, staged and untracked source", (t) => {
  const f = fixture(t);
  features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  features.runFeatureChecks(f.root, f.feature.id);
  const file = path.join(f.feature.cwd, "src/api.js");
  fs.writeFileSync(file, "dirty\n");
  assert.throws(() => features.snapshotFeature(f.root, f.feature.id), /clean/);
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
  git(f.feature.cwd, "add", "src/api.js");
  assert.throws(() => features.snapshotFeature(f.root, f.feature.id), /clean/);
  git(f.feature.cwd, "reset", "--hard", "HEAD");
  fs.writeFileSync(path.join(f.feature.cwd, "untracked.txt"), "untracked\n");
  assert.throws(() => features.snapshotFeature(f.root, f.feature.id), /untracked/);
  assert.throws(() => features.runFeatureChecks(f.root, f.feature.id), /untracked/);
  fs.unlinkSync(path.join(f.feature.cwd, "untracked.txt"));
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, true);
});

test("Git flags cannot hide modified source from snapshot and acceptance", (t) => {
  const f = fixture(t);
  features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  features.runFeatureChecks(f.root, f.feature.id);
  git(f.feature.cwd, "update-index", "--assume-unchanged", "src/api.js");
  fs.writeFileSync(path.join(f.feature.cwd, "src/api.js"), "hidden mutation\n");
  assert.equal(git(f.feature.cwd, "status", "--porcelain"), "");
  assert.throws(() => features.snapshotFeature(f.root, f.feature.id), /hidden index/);
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
  git(f.feature.cwd, "update-index", "--no-assume-unchanged", "src/api.js");
  git(f.feature.cwd, "reset", "--hard", "HEAD");
  git(f.feature.cwd, "update-index", "--skip-worktree", "src/api.js");
  assert.throws(() => features.snapshotFeature(f.root, f.feature.id), /hidden index/);
});

test("changed commit, brief, base, branch and check declarations invalidate evidence", (t) => {
  const f = fixture(t);
  assemble(f);
  const original = features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  features.runFeatureChecks(f.root, f.feature.id);
  writeCommit(f.feature.cwd, "src/extra.js", "new\n");
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
  const next = features.snapshotFeature(f.root, f.feature.id);
  assert.equal(next.generation, 2);
  assert.throws(() => review(f, "review-security", { candidate: original.candidate }), /stale/);
  approveAll(f);
  features.runFeatureChecks(f.root, f.feature.id);
  f.update((feature) => { feature.brief += " New acceptance criterion."; });
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
  assert.throws(() => review(f, "review-security"), /stale/);
  const rebrief = features.snapshotFeature(f.root, f.feature.id);
  assert.equal(rebrief.generation, 3);
  assert.notEqual(rebrief.candidate.brief_hash, next.candidate.brief_hash);
  approveAll(f);
  features.runFeatureChecks(f.root, f.feature.id);
  f.update((feature) => { feature.base = next.candidate.commit; });
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
  features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  features.runFeatureChecks(f.root, f.feature.id);
  f.update((feature) => { feature.checks[0].command = "exit 0"; });
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
  features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  features.runFeatureChecks(f.root, f.feature.id);
  git(f.feature.cwd, "checkout", "-b", "codex/impostor");
  assert.match(features.featureStatus(f.root, f.feature.id).reasons.join("\n"), /branch changed/);
});

test("generation fences old approvals even when source and brief return to an earlier value", (t) => {
  const f = fixture(t);
  const original = features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  features.runFeatureChecks(f.root, f.feature.id);
  f.update((feature) => { feature.brief = "Another brief"; });
  features.snapshotFeature(f.root, f.feature.id);
  f.update((feature) => { feature.brief = original.brief; });
  const reverted = features.snapshotFeature(f.root, f.feature.id);
  assert.equal(reverted.candidate.commit, original.candidate.commit);
  assert.equal(reverted.candidate.brief_hash, original.candidate.brief_hash);
  assert.notEqual(reverted.generation, original.generation);
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
  assert.throws(() => review(f, "review-security", { candidate: original.candidate }), /stale/);
});

test("required findings survive omission and downgrade until explicitly resolved or rejected with evidence", (t) => {
  const f = fixture(t);
  features.snapshotFeature(f.root, f.feature.id);
  features.runFeatureChecks(f.root, f.feature.id);
  review(f, "review-correctness");
  const finding = { id: "missing-guard", required: true, evidence: "src/api.js:1 lacks the requested guard" };
  review(f, "review-security", { verdict: "changes_requested", findings: [finding] });
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
  review(f, "review-security");
  assert.match(features.featureStatus(f.root, f.feature.id).reasons.join("\n"), /unresolved finding/);
  review(f, "review-security", { findings: [{ ...finding, required: false }] });
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
  assert.throws(() => review(f, "review-security", { findings: [{ ...finding, status: "resolved" }] }), /resolution evidence/);
  review(f, "review-security", { findings: [{ ...finding, status: "rejected", resolution_evidence: "The guard is enforced before this function; src/auth.js:10." }] });
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, true);
  writeCommit(f.feature.cwd, "src/fix.js", "fix\n");
  features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  features.runFeatureChecks(f.root, f.feature.id);
  assert.match(features.featureStatus(f.root, f.feature.id).reasons.join("\n"), /unresolved finding/);
  review(f, "review-security", { findings: [{ ...finding, status: "resolved", resolution_evidence: "src/fix.js:1 and the unit check cover the guard." }] });
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, true);
  review(f, "review-security", { verdict: "block_merge" });
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
});

test("reviews reject missing identity, wrong reviewer, stale brief and malformed findings", (t) => {
  const f = fixture(t);
  features.snapshotFeature(f.root, f.feature.id);
  assert.throws(() => review(f, "unassigned"), /required reviewer/);
  assert.throws(() => review(f, "review-security", { candidate: null }), /stale/);
  assert.throws(() => review(f, "review-security", { brief_hash: "old" }), /stale/);
  assert.throws(() => review(f, "review-security", { verdict: "waived" }), /verdict/);
  assert.throws(() => review(f, "review-security", { findings: undefined }), /array/);
  assert.throws(() => review(f, "review-security", { findings: [{ id: "F", evidence: "source" }] }), /required or optional/);
  assert.throws(() => review(f, "review-security", { findings: [{ id: "F", required: false }] }), /evidence/);
  const finding = { id: "F", required: false, evidence: "source" };
  assert.throws(() => review(f, "review-security", { findings: [finding, finding] }), /unique/);
  assert.throws(() => review(f, "review-security", { attempt: 0 }), /positive/);
});

test("checks capture failures, spawn errors and timeouts without accepting evidence", (t) => {
  const f = fixture(t, { checks: [
    { id: "failed", command: [process.execPath, "-e", "console.error('failed'); process.exit(7)"] },
    { id: "missing", command: ["/does-not-exist/feature-check"] },
    { id: "timeout", command: [process.execPath, "-e", "setInterval(() => {}, 1000)"], timeout_ms: 40 }
  ] });
  features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  const run = features.runFeatureChecks(f.root, f.feature.id);
  assert.equal(run.results.length, 3);
  assert.equal(run.results[0].exit_code, 7);
  assert.match(run.results[1].error, /ENOENT/);
  assert.match(run.results[2].error, /ETIMEDOUT/);
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
  assert.equal(run.cleanup_required, true);
  assert.equal(fs.existsSync(run.retained_cwd), true);
  // This fixture starts only the direct child; spawnSync has reaped it.
  git(f.repo, "worktree", "remove", "--force", run.retained_cwd);
  fs.rmSync(path.dirname(run.retained_cwd), { recursive: true, force: true });
});

test("checks accept a ten-minute configured timeout without waiting when the command exits", (t) => {
  const f = fixture(t, { checks: [{ id: "long-suite", command: [process.execPath, "-e", "process.exit(0)"], timeout_ms: 600000 }] });
  features.snapshotFeature(f.root, f.feature.id);
  assert.equal(features.runFeatureChecks(f.root, f.feature.id).status, "completed");
  assert.throws(() => features.createFeature(f.root, { ...f.input, id: "invalid-timeout", checks: [{ id: "C", command: "exit 0", timeout_ms: 600001 }] }), /1..600000/);
});

test("timed-out checks retain a scratch checkout while a descendant still writes", async (t) => {
  const f = fixture(t);
  const pidPath = path.join(f.temporary, "writer.pid");
  const stoppedPath = path.join(f.temporary, "writer.stopped");
  const childScript = `
    const fs = require('node:fs');
    const timer = setInterval(() => fs.appendFileSync('heartbeat.txt', 'tick\\n'), 20);
    process.on('SIGTERM', () => { clearInterval(timer); fs.writeFileSync(${JSON.stringify(stoppedPath)}, 'stopped'); process.exit(0); });
  `;
  const parentScript = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
    child.unref();
    setInterval(() => {}, 1000);
  `;
  f.update((feature) => { feature.checks = [{ id: "descendant", command: [process.execPath, "-e", parentScript], timeout_ms: 500 }]; });
  features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  let run;
  try {
    run = features.runFeatureChecks(f.root, f.feature.id);
    assert.equal(run.status, "failed");
    assert.equal(run.cleanup_required, true);
    assert.equal(run.retained_reason, "ETIMEDOUT");
    const heartbeat = path.join(run.retained_cwd, "heartbeat.txt");
    const before = fs.statSync(heartbeat).size;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(fs.statSync(heartbeat).size > before, "the descendant remains active after the parent timeout");
    assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
    assert.ok(git(f.repo, "worktree", "list", "--porcelain").includes(run.retained_cwd));
  } finally {
    if (fs.existsSync(pidPath)) {
      process.kill(Number(fs.readFileSync(pidPath, "utf8")), "SIGTERM");
      for (let index = 0; index < 100 && !fs.existsSync(stoppedPath); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(fs.existsSync(stoppedPath), true, "test writer acknowledged it stopped");
    }
    if (run?.retained_cwd) {
      git(f.repo, "worktree", "remove", "--force", run.retained_cwd);
      fs.rmSync(path.dirname(run.retained_cwd), { recursive: true, force: true });
    }
  }
});

for (const [name, script] of [
  ["tracked", "require('fs').writeFileSync('src/api.js', 'mutated')"],
  ["untracked", "require('fs').writeFileSync('unexpected.txt', 'mutated')"]
]) test(`check ${name} source mutation invalidates evidence and leaves feature untouched`, (t) => {
  const f = fixture(t, { checks: [{ id: "mutation", command: [process.execPath, "-e", script] }, { id: "later", command: "exit 0" }] });
  features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  const run = features.runFeatureChecks(f.root, f.feature.id);
  assert.equal(run.source_unchanged, false);
  assert.equal(run.results[0].exit_code, 0);
  assert.equal(run.results[0].passed, false);
  assert.equal(run.results.length, 1);
  assert.equal(git(f.feature.cwd, "status", "--porcelain"), "");
  assert.equal(fs.readFileSync(path.join(f.feature.cwd, "src/api.js"), "utf8"), "module.exports = 'base';\n");
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
});

test("check output disappearance or modification revokes eligibility", (t) => {
  const f = fixture(t);
  features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  const run = features.runFeatureChecks(f.root, f.feature.id);
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, true);
  fs.appendFileSync(run.results[0].stdout_path, "changed");
  assert.match(features.featureStatus(f.root, f.feature.id).reasons.join("\n"), /evidence changed/);
  fs.unlinkSync(run.results[0].stderr_path);
  assert.match(features.featureStatus(f.root, f.feature.id).reasons.join("\n"), /evidence unavailable/);
});

test("a later check infrastructure failure cannot resurrect an earlier passing run", (t) => {
  const f = fixture(t);
  features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  features.runFeatureChecks(f.root, f.feature.id);
  const evidence = path.join(f.root, ".agent-team", "evidence", "features");
  const moved = `${evidence}-saved`;
  fs.renameSync(evidence, moved);
  fs.symlinkSync(moved, evidence);
  const failed = features.runFeatureChecks(f.root, f.feature.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /unsafe directory/);
  // Restore access to the older evidence: the failed later run still governs.
  fs.unlinkSync(evidence);
  fs.renameSync(moved, evidence);
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
});

test("source changes during checks cannot pass by testing an older detached candidate", (t) => {
  const f = fixture(t);
  f.update((feature) => { feature.checks = [{ id: "racing", command: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(path.join(f.feature.cwd, "racing.txt"))}, 'changed')`] }]; });
  features.snapshotFeature(f.root, f.feature.id);
  approveAll(f);
  const run = features.runFeatureChecks(f.root, f.feature.id);
  assert.equal(run.results[0].passed, true);
  assert.equal(run.source_unchanged, false);
  fs.unlinkSync(path.join(f.feature.cwd, "racing.txt"));
  assert.equal(features.featureStatus(f.root, f.feature.id).eligible, false);
});

test("assembly requires same repository, correct ancestry and explicit allowed scope", (t) => {
  const f = fixture(t);
  const commit = writeCommit(f.worker, "src/api.js", "new\n");
  const input = { commit, worker_cwd: f.worker, allowed_paths: ["src/**"] };
  assert.throws(() => features.assembleFeature(f.root, f.feature.id, { ...input, allowed_paths: undefined }), /allowed_paths/);
  assert.throws(() => features.assembleFeature(f.root, f.feature.id, { ...input, allowed_paths: ["src/../**"] }), /traversal/);
  assert.throws(() => features.assembleFeature(f.root, f.feature.id, { ...input, allowed_paths: ["README.md"] }), /outside scope/);
  assert.throws(() => features.assembleFeature(f.root, f.feature.id, { ...input, forbidden_paths: ["src/**"] }), /outside scope/);
  assert.throws(() => features.assembleFeature(f.root, f.feature.id, { ...input, commit: "--help" }), /full commit/);
  assert.throws(() => features.assembleFeature(f.root, f.feature.id, { ...input, worker_cwd: f.repo }), /merge-base/);
  const other = path.join(f.temporary, "other");
  git(f.temporary, "clone", "--local", f.repo, other);
  assert.throws(() => features.assembleFeature(f.root, f.feature.id, { ...input, worker_cwd: other }), /same repository/);
  features.assembleFeature(f.root, f.feature.id, input);
  assert.throws(() => features.assembleFeature(f.root, f.feature.id, input), /already assembled/);
  git(f.worker, "checkout", "--orphan", "unrelated");
  git(f.worker, "rm", "-rf", ".");
  const orphan = writeCommit(f.worker, "src/unrelated.js", "unrelated\n");
  assert.throws(() => features.assembleFeature(f.root, f.feature.id, { ...input, commit: orphan }), /merge-base/);
});

test("scope includes deleted rename source, and conflicts are left visible without an automatic commit", (t) => {
  const f = fixture(t);
  git(f.worker, "mv", "src/api.js", "moved.js");
  git(f.worker, "commit", "-m", "Rename fixture");
  const renamed = git(f.worker, "rev-parse", "HEAD");
  assert.throws(() => features.assembleFeature(f.root, f.feature.id, { commit: renamed, worker_cwd: f.worker, allowed_paths: ["moved.js"] }), /src\/api.js/);
  git(f.worker, "reset", "--hard", f.feature.base);
  const commit = writeCommit(f.worker, "src/api.js", "worker\n");
  const before = writeCommit(f.feature.cwd, "src/api.js", "feature\n");
  assert.throws(() => features.assembleFeature(f.root, f.feature.id, { commit, worker_cwd: f.worker, allowed_paths: ["src/**"] }), /cherry-pick/);
  assert.equal(git(f.feature.cwd, "rev-parse", "HEAD"), before);
  assert.match(git(f.feature.cwd, "status", "--porcelain"), /UU/);
  assert.throws(() => features.snapshotFeature(f.root, f.feature.id), /clean/);
});

test("creation rejects unsafe identifiers, refs, repos, metadata paths and reused destinations", (t) => {
  const f = fixture(t);
  for (const id of ["../escape", "a/b", ".", "-x", "x\0y"]) assert.throws(() => features.getFeature(f.root, id), /path-safe/);
  const make = (change) => features.createFeature(f.root, { ...f.input, id: "another", ...change });
  assert.throws(() => make({ base: "--help" }), /unsafe Git ref/);
  assert.throws(() => make({ base: "HEAD~1" }), /unsafe Git ref/);
  assert.throws(() => make({ branch: "main" }), /codex/);
  assert.throws(() => make({ branch: "codex/../escape" }), /check-ref-format/);
  assert.throws(() => make({ branch: f.feature.branch }), /worktree/);
  assert.throws(() => make({ repo: "relative" }), /absolute/);
  assert.throws(() => make({ repo: f.root }), /git/);
  assert.throws(() => make({ cwd: f.repo }), /already exists/);
  assert.throws(() => make({ cwd: path.join(f.repo, ".git", "injected", "nested") }), /metadata/);
  assert.equal(fs.existsSync(path.join(f.repo, ".git", "injected")), false);
  assert.throws(() => make({ review_jobs: [] }), /nonempty/);
  assert.throws(() => make({ review_jobs: ["R", "R"] }), /unique/);
  assert.throws(() => make({ checks: [] }), /nonempty/);
  assert.throws(() => make({ checks: [{ id: "C", command: "exit 0" }, { id: "C", command: "exit 0" }] }), /unique/);
  assert.throws(() => make({ checks: [{ id: "C", command: [], timeout_ms: 0 }] }), /nonempty/);
  const alias = path.join(f.temporary, "repo-alias");
  fs.symlinkSync(f.worker, alias);
  const throughWorker = make({ repo: alias });
  assert.equal(throughWorker.repo, f.repo);
  const stateAliasRoot = path.join(f.temporary, "unsafe-root");
  fs.mkdirSync(stateAliasRoot);
  fs.symlinkSync(path.join(f.root, ".agent-team"), path.join(stateAliasRoot, ".agent-team"));
  assert.throws(() => features.getFeature(stateAliasRoot, f.feature.id), /unsafe directory/);
});

test("parallel review replies through coordinator aliases retain both approvals", async (t) => {
  const f = fixture(t);
  const { candidate } = features.snapshotFeature(f.root, f.feature.id);
  features.runFeatureChecks(f.root, f.feature.id);
  const alias = path.join(f.temporary, "coordinator-alias");
  fs.symlinkSync(f.root, alias);
  const modulePath = require.resolve("../src/team/features");
  const replies = f.input.review_jobs.map((reviewer_job_id, index) => new Promise((resolve, reject) => {
    const input = { reviewer_job_id, candidate, brief_hash: candidate.brief_hash, verdict: "approve", findings: [] };
    const script = `require(${JSON.stringify(modulePath)}).recordFeatureReview(process.argv[1], process.argv[2], JSON.parse(process.argv[3]))`;
    const child = spawn(process.execPath, ["-e", script, index ? alias : f.root, f.feature.id, JSON.stringify(input)]);
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(error)));
  }));
  await Promise.all(replies);
  assert.equal(features.getFeature(f.root, f.feature.id).reviews.length, 2);
  assert.equal(features.featureStatus(alias, f.feature.id).eligible, true);
});
