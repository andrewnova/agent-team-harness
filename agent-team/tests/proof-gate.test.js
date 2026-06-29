const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const state = require("../src/state");
const { transitionTask } = require("../src/transitions");
const { recordReview } = require("../src/review");
const { saveProof, runProof, markDone } = require("../src/proof");
const { tempRoot, backendTaskInput, frontendTaskInput, passingManifest } = require("./helpers");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function initGitRepo(cwd) {
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "agent-team@example.test"]);
  git(cwd, ["config", "user.name", "Agent Team"]);
}

test("PG-1 refuses done with missing proof manifest", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput({ status: "verifying" }));
  recordReview(cwd, {
    task_id: task.task_id,
    reviewer: "claude",
    owner: "codex",
    verdict: "approve",
    required_fixes: [],
    optional_suggestions: [],
    questions: []
  });
  const result = markDone(cwd, task.task_id);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /proof manifest/);
});

test("PG-2 refuses done with missing approved review", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput({ status: "verifying" }));
  saveProof(cwd, passingManifest(task.task_id));
  const result = markDone(cwd, task.task_id);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /review/);
});

test("PG-3 rejects illegal transition", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput({ status: "ready" }));
  const result = transitionTask(cwd, task.task_id, "done");
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /illegal transition/);
});

test("PG-4 accepts done only when review and proof pass", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, backendTaskInput({ status: "verifying" }));
  recordReview(cwd, {
    task_id: task.task_id,
    reviewer: "claude",
    owner: "codex",
    verdict: "approve",
    required_fixes: [],
    optional_suggestions: [],
    questions: []
  });
  saveProof(cwd, passingManifest(task.task_id));
  const result = markDone(cwd, task.task_id);
  assert.equal(result.ok, true);
  assert.equal(state.loadTask(cwd, task.task_id).status, "done");
});

test("PG-5 refuses done when browser or screenshot artifact is missing", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, frontendTaskInput({ status: "verifying" }));
  recordReview(cwd, {
    task_id: task.task_id,
    reviewer: "codex",
    owner: "claude",
    verdict: "approve",
    required_fixes: [],
    optional_suggestions: [],
    questions: []
  });
  saveProof(cwd, passingManifest(task.task_id));
  const result = markDone(cwd, task.task_id);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /browser artifact/);
  assert.match(result.errors.join(" "), /screenshot artifact/);
});

test("PG-6 runs proof commands into a manifest and allows done after approved review", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(
    cwd,
    backendTaskInput({
      status: "verifying",
      proof: {
        commands: ["node -e \"process.stdout.write('proof-ok')\""],
        requires_browser: false,
        requires_screenshot: false
      }
    })
  );
  recordReview(cwd, {
    task_id: task.task_id,
    reviewer: "claude",
    owner: "codex",
    verdict: "approve",
    required_fixes: [],
    optional_suggestions: [],
    questions: []
  });
  const proof = runProof(cwd, task.task_id);
  assert.equal(proof.ok, true);
  assert.equal(proof.manifest.verdict, "pass");
  assert.equal(proof.manifest.commands[0].exit_code, 0);
  const result = markDone(cwd, task.task_id);
  assert.equal(result.ok, true);
});

test("PG-7 frontend proof requires console evidence when the frontend contract requires it", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, frontendTaskInput({ status: "verifying" }));
  fs.mkdirSync(path.join(cwd, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "evidence", "browser-run.json"), "{}\n");
  fs.writeFileSync(path.join(cwd, "evidence", "settings-mobile.png"), "fake image\n");
  fs.writeFileSync(path.join(cwd, "evidence", "console-clean.json"), "{}\n");
  recordReview(cwd, {
    task_id: task.task_id,
    reviewer: "codex",
    owner: "claude",
    verdict: "approve",
    required_fixes: [],
    optional_suggestions: [],
    questions: []
  });
  saveProof(
    cwd,
    passingManifest(task.task_id, {
      artifacts: {
        browser_runs: ["evidence/browser-run.json"],
        screenshots: ["evidence/settings-mobile.png"],
        console_checks: []
      }
    })
  );
  const missingConsole = markDone(cwd, task.task_id);
  assert.equal(missingConsole.ok, false);
  assert.match(missingConsole.errors.join(" "), /console check artifact/);
  saveProof(
    cwd,
    passingManifest(task.task_id, {
      artifacts: {
        browser_runs: ["evidence/browser-run.json"],
        screenshots: ["evidence/settings-mobile.png"],
        console_checks: ["evidence/console-clean.json"]
      }
    })
  );
  const done = markDone(cwd, task.task_id);
  assert.equal(done.ok, true);
});

test("PG-9 refuses done when referenced browser artifacts do not exist", () => {
  const cwd = tempRoot();
  state.init(cwd);
  const task = state.createTask(cwd, frontendTaskInput({ status: "verifying" }));
  recordReview(cwd, {
    task_id: task.task_id,
    reviewer: "codex",
    owner: "claude",
    verdict: "approve",
    required_fixes: [],
    optional_suggestions: [],
    questions: []
  });
  saveProof(
    cwd,
    passingManifest(task.task_id, {
      artifacts: {
        browser_runs: ["evidence/missing-browser-run.json"],
        screenshots: ["evidence/missing-settings-mobile.png"],
        console_checks: ["evidence/missing-console-clean.json"]
      }
    })
  );
  const result = markDone(cwd, task.task_id);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /browser artifact is missing/);
  assert.match(result.errors.join(" "), /screenshot artifact is missing/);
  assert.match(result.errors.join(" "), /console check artifact is missing/);
});

test("PG-8 refuses done when git-backed source changes after proof", () => {
  const cwd = tempRoot();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src", "api.js"), "module.exports = 1;\n");
  git(cwd, ["add", "src/api.js"]);
  git(cwd, ["commit", "-m", "init"]);
  state.init(cwd);
  const task = state.createTask(
    cwd,
    backendTaskInput({
      status: "verifying",
      proof: {
        commands: ["node -e \"process.stdout.write(require('./src/api.js').toString())\""],
        requires_browser: false,
        requires_screenshot: false
      }
    })
  );
  recordReview(cwd, {
    task_id: task.task_id,
    reviewer: "claude",
    owner: "codex",
    verdict: "approve",
    required_fixes: [],
    optional_suggestions: [],
    questions: []
  });
  const proof = runProof(cwd, task.task_id);
  assert.equal(proof.ok, true);
  assert.equal(proof.manifest.source_state.available, true);
  fs.writeFileSync(path.join(cwd, "src", "api.js"), "module.exports = 2;\n");
  const stale = markDone(cwd, task.task_id);
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join(" "), /source tree changed since proof run/);
  const freshProof = runProof(cwd, task.task_id);
  assert.equal(freshProof.ok, true);
  const done = markDone(cwd, task.task_id);
  assert.equal(done.ok, true);
});
