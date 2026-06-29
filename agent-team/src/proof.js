const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { readJson, writeJson, writeText, exists } = require("./fsutil");
const paths = require("./paths");
const { validateProofManifest } = require("./schema");
const { loadTask, saveTask, recordEvent } = require("./state");
const { approvedReview } = require("./review");
const { sourceSnapshot } = require("./sourceSnapshot");
const { findReusableBrowserProof } = require("./browserProof");
const db = require("./db");

function hasWaiver(manifest, kind) {
  return (manifest.waivers || []).some((waiver) => waiver.kind === kind || waiver.kind === "proof_artifact");
}

function commandFailures(manifest) {
  return manifest.commands.filter((command) => command.exit_code !== 0);
}

function consoleCheckRequired(task) {
  return Boolean(task.frontend_contract && task.frontend_contract.console_check_required);
}

function artifactReferenceExists(cwd, reference) {
  if (typeof reference !== "string" || reference.trim() === "") return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(reference)) return true;
  const file = path.isAbsolute(reference) ? reference : path.join(cwd, reference);
  return exists(file);
}

function missingArtifactReferences(cwd, references) {
  return (references || []).filter((reference) => !artifactReferenceExists(cwd, reference));
}

function evaluateProof(cwd, task, manifest) {
  validateProofManifest(manifest);
  const errors = [];
  const currentSource = sourceSnapshot(cwd);
  const browserRuns = manifest.artifacts.browser_runs || [];
  const screenshots = manifest.artifacts.screenshots || [];
  const consoleChecks = manifest.artifacts.console_checks || [];
  const computerRuns = manifest.artifacts.computer_runs || [];
  if (task.status !== "verifying") errors.push("task must be verifying");
  if (manifest.verdict !== "pass") errors.push("proof manifest verdict must be pass");
  if (commandFailures(manifest).length > 0) errors.push("all proof commands must pass");
  if (!approvedReview(cwd, task)) errors.push("approved review or review waiver is required");
  if (manifest.source_state && manifest.source_state.changed_during_proof) {
    errors.push("source tree changed during proof run");
  }
  if (currentSource.reason === "git_source_snapshot_failed") {
    errors.push("current source tree could not be verified");
  }
  if (currentSource.available) {
    if (!manifest.source_digest || manifest.source_digest === "unknown-source") {
      errors.push("source digest is required for git-backed proof");
    } else if (manifest.source_digest !== currentSource.source_digest) {
      errors.push("source tree changed since proof run");
    }
  }
  if (task.proof.requires_browser && !browserRuns.length && !hasWaiver(manifest, "browser")) {
    errors.push("browser artifact or waiver is required");
  }
  if (task.proof.requires_screenshot && !screenshots.length && !hasWaiver(manifest, "screenshot")) {
    errors.push("screenshot artifact or waiver is required");
  }
  if (consoleCheckRequired(task) && !consoleChecks.length && !hasWaiver(manifest, "console")) {
    errors.push("console check artifact or waiver is required");
  }
  if (task.proof.requires_computer && !computerRuns.length && !hasWaiver(manifest, "computer")) {
    errors.push("computer-use artifact or waiver is required");
  }
  for (const reference of missingArtifactReferences(cwd, browserRuns)) {
    errors.push(`browser artifact is missing: ${reference}`);
  }
  for (const reference of missingArtifactReferences(cwd, screenshots)) {
    errors.push(`screenshot artifact is missing: ${reference}`);
  }
  for (const reference of missingArtifactReferences(cwd, consoleChecks)) {
    errors.push(`console check artifact is missing: ${reference}`);
  }
  for (const reference of missingArtifactReferences(cwd, computerRuns)) {
    errors.push(`computer-use artifact is missing: ${reference}`);
  }
  return { ok: errors.length === 0, errors };
}

function saveProof(cwd, manifest) {
  validateProofManifest(manifest);
  const task = loadTask(cwd, manifest.task_id);
  writeJson(paths.proofPath(cwd, manifest.task_id), manifest);
  db.upsertProof(cwd, manifest);
  recordEvent(cwd, {
    type: "proof.saved",
    goal_id: task.goal_id,
    task_id: manifest.task_id,
    owner: task.owner,
    reviewer: task.reviewer,
    status: task.status,
    detail: {
      verdict: manifest.verdict,
      commands: manifest.commands.length,
      browser_runs: (manifest.artifacts.browser_runs || []).length,
      screenshots: (manifest.artifacts.screenshots || []).length,
      computer_runs: (manifest.artifacts.computer_runs || []).length,
      waivers: (manifest.waivers || []).length
    }
  });
  return manifest;
}

function gitValue(cwd, args, fallback) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return fallback;
  const value = result.stdout.trim();
  return value || fallback;
}

function defaultRunId() {
  return `run-${new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "-").replace(/-$/, "")}`;
}

function relative(cwd, file) {
  return path.relative(cwd, file) || file;
}

function runCommand(cwd, runDir, command, index, timeoutMs) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024
  });
  const stem = `command-${String(index + 1).padStart(3, "0")}`;
  const stdoutPath = path.join(runDir, "logs", `${stem}.stdout.log`);
  const stderrPath = path.join(runDir, "logs", `${stem}.stderr.log`);
  writeText(stdoutPath, result.stdout || "");
  writeText(stderrPath, result.stderr || "");
  return {
    cmd: command,
    exit_code: typeof result.status === "number" ? result.status : result.signal ? 124 : 1,
    stdout: relative(cwd, stdoutPath),
    stderr: relative(cwd, stderrPath),
    signal: result.signal || undefined,
    error: result.error ? result.error.message : undefined
  };
}

function waiver(kind, reason, approvedBy = "human") {
  return {
    kind,
    reason,
    approved_by: approvedBy,
    created_at: new Date().toISOString()
  };
}

function runProof(cwd, taskId, options = {}) {
  const task = loadTask(cwd, taskId);
  const runId = options.run_id || defaultRunId();
  const runDir = paths.evidenceDir(cwd, taskId, runId);
  const timeoutMs = options.timeout_ms;
  const sourceBefore = sourceSnapshot(cwd);
  const reusableBrowserProof = findReusableBrowserProof(cwd, taskId, {
    source_digest: sourceBefore.source_digest
  });
  const browserRuns = [...(options.browser_runs || [])];
  const screenshots = [...(options.screenshots || [])];
  const consoleChecks = [...(options.console_checks || [])];
  const browserFindings = [];
  if (reusableBrowserProof.ok) {
    if (task.proof.requires_browser && browserRuns.length === 0 && reusableBrowserProof.artifacts.browser_run) {
      browserRuns.push(reusableBrowserProof.artifacts.browser_run);
    }
    if (task.proof.requires_screenshot && screenshots.length === 0 && reusableBrowserProof.artifacts.screenshot) {
      screenshots.push(reusableBrowserProof.artifacts.screenshot);
    }
    if (consoleCheckRequired(task) && consoleChecks.length === 0 && reusableBrowserProof.artifacts.console_check) {
      consoleChecks.push(reusableBrowserProof.artifacts.console_check);
    }
    if (reusableBrowserProof.artifacts.findings) browserFindings.push(reusableBrowserProof.artifacts.findings);
  }
  const commands = task.proof.commands.map((command, index) => runCommand(cwd, runDir, command, index, timeoutMs));
  const sourceAfter = sourceSnapshot(cwd);
  const manifest = {
    task_id: taskId,
    tree_hash: options.tree_hash || sourceBefore.tree_hash || gitValue(cwd, ["rev-parse", "HEAD"], "unknown-tree"),
    merge_ref: options.merge_ref || sourceBefore.merge_ref || gitValue(cwd, ["branch", "--show-current"], "unknown-ref"),
    source_digest: sourceBefore.source_digest,
    source_state: {
      available: sourceBefore.available,
      dirty: sourceBefore.dirty,
      changed_count: sourceBefore.changed_count,
      changed_paths: sourceBefore.changed_paths || [],
      reason: sourceBefore.reason,
      changed_during_proof: sourceBefore.source_digest !== sourceAfter.source_digest
    },
    commands,
    artifacts: {
      browser_runs: browserRuns,
      screenshots,
      console_checks: consoleChecks,
      computer_runs: options.computer_runs || [],
      browser_findings: browserFindings
    },
    reused_browser_proof: reusableBrowserProof.ok
      ? {
          run_id: reusableBrowserProof.run_id,
          source_digest: reusableBrowserProof.source_digest,
          artifacts: reusableBrowserProof.artifacts
        }
      : undefined,
    waivers: options.waivers || [],
    verdict: commands.some((command) => command.exit_code !== 0) ? "fail" : "pass"
  };
  saveProof(cwd, manifest);
  recordEvent(cwd, {
    type: "proof.run",
    goal_id: task.goal_id,
    task_id: taskId,
    owner: task.owner,
    reviewer: task.reviewer,
    status: task.status,
    detail: {
      run_id: runId,
      verdict: manifest.verdict,
      commands: commands.length,
      evidence_dir: relative(cwd, runDir)
    }
  });
  return {
    ok: manifest.verdict === "pass",
    task_id: taskId,
    run_id: runId,
    evidence_dir: runDir,
    manifest_path: paths.proofPath(cwd, taskId),
    manifest
  };
}

function loadProof(cwd, taskId) {
  const file = paths.proofPath(cwd, taskId);
  if (!exists(file)) return null;
  return readJson(file);
}

function markDone(cwd, taskId) {
  const task = loadTask(cwd, taskId);
  const manifest = loadProof(cwd, taskId);
  if (!manifest) {
    return { ok: false, errors: ["proof manifest is required"] };
  }
  const result = evaluateProof(cwd, task, manifest);
  if (!result.ok) return result;
  task.status = "done";
  saveTask(cwd, task);
  recordEvent(cwd, {
    type: "task.done",
    goal_id: task.goal_id,
    task_id: task.task_id,
    owner: task.owner,
    reviewer: task.reviewer,
    status: task.status,
    detail: {
      proof: relative(cwd, paths.proofPath(cwd, taskId))
    }
  });
  return { ok: true, task };
}

module.exports = {
  evaluateProof,
  artifactReferenceExists,
  missingArtifactReferences,
  saveProof,
  runProof,
  loadProof,
  markDone,
  sourceSnapshot,
  waiver
};
