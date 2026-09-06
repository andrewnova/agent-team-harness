// Opt-in feature authority. The CLI authenticates reviewer job/attempt/runtime;
// this module binds that review and check evidence to a frozen Git candidate.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const paths = require("../paths");
const { readJson, writeJson } = require("../fsutil");
const { normalizeChangedPath, isPathAllowed } = require("../pathScope");

const digest = (value) => createHash("sha256").update(value).digest("hex");
const timestamp = () => new Date().toISOString();

function text(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} must be nonempty text`);
  return value;
}

function safeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw new Error("id must be path-safe (letters, numbers, underscore, hyphen)");
  return value;
}

function absolute(value, label) {
  text(value, label);
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}

// Reject symlinked state children; aliases of the explicit coordinator root are
// canonicalized once, so independent callers use the same lock and state files.
function directory(parent, ...parts) {
  let current = parent;
  for (const part of parts) {
    current = path.join(current, part);
    try { fs.mkdirSync(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe directory: ${current}`);
  }
  return current;
}

function featureFile(root, id) {
  const coordinator = fs.realpathSync(absolute(root, "root"));
  safeId(id);
  const dir = directory(coordinator, ".agent-team", "state", "features");
  return path.join(dir, `${id}.json`);
}

function readFeature(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`unsafe feature file: ${file}`);
  return readJson(file);
}

function saveFeature(file, feature) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeJson(temporary, { ...feature, updated_at: timestamp() });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return readFeature(file);
}

function locked(root, id, action) {
  const file = featureFile(root, id);
  const lock = `${file}.lock`;
  const deadline = Date.now() + 2000;
  while (true) {
    try { fs.mkdirSync(lock); break; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`feature busy; retry after the current operation: ${id}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return action(file); } finally { fs.rmdirSync(lock); }
}

function git(cwd, args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd, env, encoding: "utf8", timeout: 30000, maxBuffer: 20 * 1024 * 1024
  });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
  return result.stdout.trim();
}

function repository(cwd) {
  const requested = fs.realpathSync(absolute(cwd, "repo"));
  if (git(requested, ["rev-parse", "--is-bare-repository"]) !== "false") throw new Error("repo must have a working tree");
  const common = fs.realpathSync(git(requested, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const listing = git(requested, ["worktree", "list", "--porcelain", "-z"]).split("\0");
  const main = listing.find((line) => line.startsWith("worktree "));
  if (!main) throw new Error("repo has no canonical worktree");
  return { repo: fs.realpathSync(main.slice(9)), git_common_dir: common };
}

function resolveCommit(repo, ref) {
  if (typeof ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes("..")) throw new Error("unsafe Git ref");
  return git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

function requirements(feature) {
  if (!["codex", "claude"].includes(feature.leader)) throw new Error("leader must be codex or claude");
  const jobs = feature.review_jobs;
  if (!Array.isArray(jobs) || !jobs.length || new Set(jobs).size !== jobs.length) throw new Error("review_jobs must be unique and nonempty");
  jobs.forEach(safeId);
  if (!Array.isArray(feature.checks) || !feature.checks.length) throw new Error("checks must be nonempty");
  const checks = feature.checks.map((check) => {
    safeId(check.id);
    if (Array.isArray(check.command)) {
      if (!check.command.length) throw new Error("check command argv must be nonempty");
      check.command.forEach((arg) => text(arg, "check command argument"));
    } else text(check.command, "check command");
    const timeout_ms = check.timeout_ms ?? 60000;
    if (!Number.isInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 600000) throw new Error("check timeout_ms must be 1..600000");
    return { id: check.id, command: check.command, timeout_ms };
  });
  if (new Set(checks.map((check) => check.id)).size !== checks.length) throw new Error("check ids must be unique");
  return { leader: feature.leader, review_jobs: [...jobs].sort(), checks };
}

function assertClean(cwd) {
  if (git(cwd, ["ls-files", "-v", "-z"]).split("\0").some((entry) => entry && (entry[0] === "S" || /[a-z]/.test(entry[0])))) throw new Error("source has hidden index entries (skip-worktree or assume-unchanged)");
  if (git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])) throw new Error("feature must be clean, including untracked files");
}

function source(feature) {
  const location = fs.realpathSync(feature.cwd);
  const identity = repository(location);
  if (location !== feature.cwd || identity.git_common_dir !== feature.git_common_dir || identity.repo !== feature.repo) throw new Error("feature repository identity changed");
  if (git(location, ["symbolic-ref", "HEAD"]) !== `refs/heads/${feature.branch}`) throw new Error("feature branch changed");
  assertClean(location);
  const commit = resolveCommit(location, "HEAD");
  if (resolveCommit(location, feature.base) !== feature.base) throw new Error("feature base must be a full commit id");
  git(location, ["merge-base", "--is-ancestor", feature.base, commit]);
  return {
    commit, tree: git(location, ["rev-parse", "HEAD^{tree}"]), base: feature.base,
    brief_hash: digest(text(feature.brief, "brief")), requirements_hash: digest(JSON.stringify(requirements(feature)))
  };
}

function sameCandidate(left, right) {
  return Boolean(left && right && ["commit", "tree", "base", "brief_hash", "requirements_hash", "generation"].every((key) => left[key] === right[key]));
}

function currentCandidate(feature) {
  if (!feature.candidate) throw new Error("feature needs a frozen candidate");
  const current = { ...source(feature), generation: feature.generation };
  if (!sameCandidate(feature.candidate, current)) throw new Error("candidate is stale; snapshot current source and brief");
  return feature.candidate;
}

// Resolve existing ancestors before mkdir, including aliases into Git metadata.
function prospectivePath(destination) {
  const tail = [];
  let parent = destination;
  while (true) {
    try { return path.join(fs.realpathSync(parent), ...tail); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      tail.unshift(path.basename(parent));
      parent = path.dirname(parent);
    }
  }
}

function createFeature(root, input) {
  const required = requirements(input);
  text(input.brief, "brief");
  return locked(root, input.id, (file) => {
    if (fs.existsSync(file)) throw new Error(`feature already exists: ${input.id}`);
    const identity = repository(input.repo);
    const base = resolveCommit(identity.repo, input.base || "HEAD");
    const branch = input.branch || `codex/${input.id}`;
    if (!branch.startsWith("codex/")) throw new Error("feature branch must use codex/ prefix");
    git(identity.repo, ["check-ref-format", `refs/heads/${branch}`]);
    const coordinator = fs.realpathSync(absolute(root, "root"));
    const destination = input.cwd ? absolute(input.cwd, "cwd") : path.join(paths.worktreesDir(coordinator), "features", input.id);
    // No existing path (even an empty directory or dangling symlink) is reused.
    try { fs.lstatSync(destination); throw new Error("feature cwd already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const cwd = prospectivePath(destination);
    const inside = (parent) => cwd === parent || cwd.startsWith(`${parent}${path.sep}`);
    if (cwd.split(path.sep).includes(".git") || inside(identity.git_common_dir) || (inside(paths.rootDir(coordinator)) && !inside(paths.worktreesDir(coordinator)))) throw new Error("unsafe feature cwd inside metadata");
    fs.mkdirSync(path.dirname(cwd), { recursive: true });
    git(identity.repo, ["worktree", "add", "-b", branch, "--", cwd, base]);
    return saveFeature(file, {
      id: input.id, ...identity, cwd: fs.realpathSync(cwd), branch, base, base_ref: input.base || "HEAD",
      brief: input.brief, brief_hash: digest(input.brief), ...required,
      generation: 0, candidate: null, assemblies: [], reviews: [], check_runs: [], created_at: timestamp()
    });
  });
}

function getFeature(root, id) {
  return readFeature(featureFile(root, id));
}

// A single committed worker patch is imported, never its whole branch. Passing
// the worker checkout and an explicit scope keeps assembly independently useful
// without trusting legacy tasks or accepting a caller's "already validated" flag.
function assembleFeature(root, id, { commit, worker_cwd, allowed_paths, forbidden_paths = [] }) {
  return locked(root, id, (file) => {
    const feature = readFeature(file);
    source(feature);
    if (typeof commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("worker commit must be a full commit id");
    if (repository(worker_cwd).git_common_dir !== feature.git_common_dir) throw new Error("worker must belong to the same repository");
    if (!Array.isArray(allowed_paths) || !allowed_paths.length || !Array.isArray(forbidden_paths)) throw new Error("explicit allowed_paths scope is required");
    for (const pattern of [...allowed_paths, ...forbidden_paths]) {
      if (normalizeChangedPath(pattern) !== pattern) throw new Error("scope paths must be normalized relative paths");
    }
    resolveCommit(worker_cwd, commit);
    git(worker_cwd, ["merge-base", "--is-ancestor", commit, "HEAD"]);
    git(worker_cwd, ["merge-base", "--is-ancestor", feature.base, commit]);
    const parents = git(worker_cwd, ["rev-list", "--parents", "-n", "1", commit]).split(" ");
    if (parents.length !== 2) throw new Error("worker commit must have exactly one parent");
    const changed_paths = git(worker_cwd, ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", parents[1], commit]).split("\0").filter(Boolean);
    if (!changed_paths.length) throw new Error("worker commit has no changes");
    const outside = changed_paths.filter((name) => normalizeChangedPath(name) !== name || !isPathAllowed(name, { allowed_paths, forbidden_paths }));
    if (outside.length) throw new Error(`worker changes outside scope: ${outside.join(", ")}`);
    if (feature.assemblies.some((item) => item.worker_commit === commit)) throw new Error("worker commit already assembled");
    // Conflicts remain visible in the isolated feature; never stage or resolve them.
    git(feature.cwd, ["cherry-pick", "--", commit]);
    feature.assemblies.push({ worker_commit: commit, worker_cwd: fs.realpathSync(worker_cwd), changed_paths, commit: resolveCommit(feature.cwd, "HEAD"), assembled_at: timestamp() });
    feature.candidate = null;
    return saveFeature(file, feature);
  });
}

function snapshotFeature(root, id) {
  return locked(root, id, (file) => {
    const feature = readFeature(file);
    const identity = source(feature);
    if (sameCandidate(feature.candidate, { ...identity, generation: feature.generation })) return feature;
    feature.generation += 1;
    feature.brief_hash = identity.brief_hash;
    feature.candidate = { ...identity, generation: feature.generation };
    return saveFeature(file, feature);
  });
}

function recordFeatureReview(root, id, input) {
  return locked(root, id, (file) => {
    const feature = readFeature(file);
    const candidate = currentCandidate(feature);
    if (!feature.review_jobs.includes(input.reviewer_job_id)) throw new Error("reviewer_job_id is not a required reviewer");
    if (!sameCandidate(input.candidate, candidate) || input.brief_hash !== candidate.brief_hash) throw new Error("review candidate or brief is stale");
    if (!["approve", "changes_requested", "block_merge"].includes(input.verdict)) throw new Error("invalid review verdict");
    if (!Array.isArray(input.findings)) throw new Error("findings must explicitly be an array");
    if (input.attempt !== undefined && (!Number.isInteger(input.attempt) || input.attempt < 1)) throw new Error("attempt must be positive");
    const findings = input.findings.map((finding) => {
      safeId(finding.id);
      if (typeof finding.required !== "boolean") throw new Error("finding must explicitly be required or optional");
      const status = finding.status || "open";
      if (!["open", "resolved", "rejected"].includes(status)) throw new Error("invalid finding status");
      const evidence = text(finding.evidence, "finding evidence");
      const resolution_evidence = status === "open" ? null : text(finding.resolution_evidence, "resolution evidence");
      return { id: finding.id, required: finding.required, status, evidence, resolution_evidence };
    });
    if (new Set(findings.map((finding) => finding.id)).size !== findings.length) throw new Error("finding ids must be unique per reviewer");
    const review = { reviewer_job_id: input.reviewer_job_id, candidate, brief_hash: candidate.brief_hash, verdict: input.verdict, findings, attempt: input.attempt, recorded_at: timestamp() };
    feature.reviews.push(review);
    saveFeature(file, feature);
    return review;
  });
}

function runFeatureChecks(root, id) {
  const run_id = randomUUID();
  const feature = locked(root, id, (file) => {
    const current = readFeature(file);
    const candidate = currentCandidate(current);
    // Persist before executing: a pending or interrupted later run cannot fall
    // back to older passing evidence. Concurrent runs retain their start order.
    current.check_runs.push({ run_id, candidate, status: "running", results: [], source_unchanged: false, recorded_at: timestamp() });
    return saveFeature(file, current);
  });
  const candidate = feature.candidate;
  const run = { ...feature.check_runs.at(-1), status: "completed", source_unchanged: true };
  let temporary;
  let cwd;
  let added = false;
  let retain = false;
  try {
    const coordinator = fs.realpathSync(absolute(root, "root"));
    const evidence = directory(coordinator, ".agent-team", "evidence", "features", safeId(id), run_id);
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-feature-check-"));
    cwd = path.join(temporary, "source");
    git(feature.repo, ["worktree", "add", "--detach", "--", cwd, candidate.commit]);
    added = true;
    for (const check of requirements(feature).checks) {
      const argv = Array.isArray(check.command) ? check.command : ["/bin/sh", "-c", check.command];
      // Commands are declared by the operator, never assembled from review text.
      const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", timeout: check.timeout_ms, maxBuffer: 10 * 1024 * 1024 });
      // A synchronous timeout/abort stops the direct child, not its descendants.
      // Keep their checkout until the operator confirms every writer stopped.
      retain = result.error?.code === "ETIMEDOUT" || Boolean(result.pid && (result.error || result.signal));
      if (retain) {
        run.retained_cwd = cwd;
        run.retained_reason = result.error?.code || result.signal;
        run.cleanup_required = true;
        run.source_unchanged = false;
      }
      const stdout_path = path.join(evidence, `${check.id}.stdout.log`);
      const stderr_path = path.join(evidence, `${check.id}.stderr.log`);
      fs.writeFileSync(stdout_path, result.stdout || "");
      fs.writeFileSync(stderr_path, result.stderr || "");
      let clean = false;
      let source_error = null;
      try {
        assertClean(cwd);
        clean = resolveCommit(cwd, "HEAD") === candidate.commit;
      } catch (error) { source_error = error.message; }
      run.source_unchanged &&= clean;
      run.results.push({
        id: check.id, command: check.command, candidate, exit_code: result.status, signal: result.signal,
        error: result.error?.message || null, source_error, source_unchanged: clean,
        passed: result.status === 0 && !result.error && clean,
        stdout_path, stderr_path, stdout_hash: digest(result.stdout || ""), stderr_hash: digest(result.stderr || "")
      });
      if (!clean || retain) break;
    }
  } catch (error) {
    run.error = error.message;
    run.source_unchanged = false;
  } finally {
    try {
      if (added && !retain) git(feature.repo, ["worktree", "remove", "--force", "--", cwd]);
      if (temporary && !retain) fs.rmSync(temporary, { recursive: true, force: true });
    } catch (error) {
      run.cleanup_error = error.message;
      run.source_unchanged = false;
    }
  }
  return locked(root, id, (file) => {
    const current = readFeature(file);
    try { run.source_unchanged &&= sameCandidate(candidate, currentCandidate(current)); } catch (error) {
      run.source_unchanged = false;
      run.error = error.message;
    }
    if (!run.source_unchanged || run.results.some((result) => !result.passed)) run.status = "failed";
    const index = current.check_runs.findIndex((item) => item.run_id === run_id);
    if (index < 0) throw new Error("check run disappeared from feature state");
    current.check_runs[index] = run;
    saveFeature(file, current);
    return run;
  });
}

function featureStatus(root, id) {
  const feature = getFeature(root, id);
  const reasons = [];
  try { currentCandidate(feature); } catch (error) { reasons.push(error.message); }
  for (const reviewer of feature.review_jobs) {
    const history = feature.reviews.filter((review) => review.reviewer_job_id === reviewer);
    const review = history.filter((item) => sameCandidate(item.candidate, feature.candidate)).at(-1);
    if (!review) reasons.push(`missing review: ${reviewer}`);
    else if (review.verdict !== "approve") reasons.push(`review ${reviewer}: ${review.verdict}`);
    // A required finding cannot disappear or be downgraded in a later reply.
    const findings = new Map();
    for (const item of history) for (const finding of item.findings) {
      const prior = findings.get(finding.id);
      findings.set(finding.id, { ...finding, required: finding.required || prior?.required, candidate: item.candidate });
    }
    for (const finding of findings.values()) {
      if (finding.required && (finding.status === "open" || !finding.resolution_evidence || !sameCandidate(finding.candidate, feature.candidate))) reasons.push(`unresolved finding: ${reviewer}/${finding.id}`);
    }
  }
  const run = feature.check_runs.filter((item) => sameCandidate(item.candidate, feature.candidate)).at(-1);
  for (const check of feature.checks) {
    const result = run?.results.find((item) => item.id === check.id);
    if (run?.status !== "completed" || !run.source_unchanged || !result?.passed || !sameCandidate(result.candidate, feature.candidate)) {
      reasons.push(`check missing, failed, or mutated: ${check.id}`);
      continue;
    }
    for (const stream of ["stdout", "stderr"]) {
      try {
        if (digest(fs.readFileSync(result[`${stream}_path`])) !== result[`${stream}_hash`]) reasons.push(`check evidence changed: ${check.id}/${stream}`);
      } catch (error) { reasons.push(`check evidence unavailable: ${check.id}/${stream}: ${error.message}`); }
    }
  }
  return { id: feature.id, eligible: reasons.length === 0, candidate: feature.candidate, reasons };
}

module.exports = { createFeature, getFeature, assembleFeature, snapshotFeature, currentCandidate, recordFeatureReview, runFeatureChecks, featureStatus };
