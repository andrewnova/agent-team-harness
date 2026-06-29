const fs = require("node:fs");
const path = require("node:path");
const paths = require("./paths");
const { ensureDir, writeJson } = require("./fsutil");
const { loadTask, recordEvent } = require("./state");

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function defaultRunId() {
  return `computer-run-${new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "-").replace(/-$/, "")}`;
}

function relative(cwd, file) {
  return path.relative(cwd, file) || file;
}

function existingArtifact(cwd, value) {
  if (!value) return null;
  const file = path.isAbsolute(value) ? value : path.join(cwd, value);
  if (!fs.existsSync(file)) throw new Error(`computer-use artifact does not exist: ${value}`);
  return relative(cwd, file);
}

function runComputerProof(cwd, taskId, options = {}) {
  const task = loadTask(cwd, taskId);
  const runId = options.run_id || defaultRunId();
  const runDir = paths.evidenceDir(cwd, taskId, runId);
  let artifact = existingArtifact(cwd, options.artifact);
  if (!artifact && options.fake) {
    const fakePath = path.join(runDir, "screenshots", "computer-use-fake.png");
    ensureDir(path.dirname(fakePath));
    fs.writeFileSync(fakePath, Buffer.from(TINY_PNG, "base64"));
    artifact = relative(cwd, fakePath);
  }
  if (!artifact) throw new Error("verify computer requires --artifact <path> or --fake");
  const computerRunPath = path.join(runDir, "computer-run.json");
  const computerRun = {
    ok: true,
    task_id: task.task_id,
    run_id: runId,
    app: options.app || "desktop-app",
    interaction: options.interaction || "manual-codex-computer-use",
    note: options.note || "",
    artifact,
    fake: Boolean(options.fake),
    completed_at: new Date().toISOString()
  };
  writeJson(computerRunPath, computerRun);
  const artifacts = {
    computer_run: relative(cwd, computerRunPath),
    artifact
  };
  recordEvent(cwd, {
    type: "computer.proof",
    goal_id: task.goal_id,
    task_id: task.task_id,
    owner: task.owner,
    reviewer: task.reviewer,
    status: task.status,
    detail: {
      run_id: runId,
      app: computerRun.app,
      interaction: computerRun.interaction,
      fake: computerRun.fake,
      artifacts
    }
  });
  return {
    ok: true,
    task_id: task.task_id,
    run_id: runId,
    evidence_dir: runDir,
    artifacts,
    verify_args: ["--computer-run", artifacts.computer_run]
  };
}

module.exports = {
  runComputerProof
};
