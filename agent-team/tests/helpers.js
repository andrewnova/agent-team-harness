const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-"));
}

function writeExecutable(file, lines) {
  fs.writeFileSync(file, lines.join("\n"));
  fs.chmodSync(file, 0o755);
  return file;
}

function installFakeBinary(binDir, name, lines) {
  return writeExecutable(path.join(binDir, name), lines);
}

function withPathEnv(binDir, fn, extraEnv = {}, options = {}) {
  const previous = {};
  const nextEnv = {
    PATH: options.replacePath ? binDir : `${binDir}:${process.env.PATH}`,
    ...extraEnv
  };
  for (const [key, value] of Object.entries(nextEnv)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withFakeClaudeEnvironment(options) {
  const { binDir, env = {}, body } = options;
  return withPathEnv(binDir, body, env);
}

function frontendContract() {
  return {
    target_flow: "User opens settings and changes notification preference.",
    responsive_states: ["desktop", "mobile"],
    interaction_states: ["default", "loading", "error"],
    visual_acceptance: ["No overflow at mobile width", "Primary action remains visible"],
    accessibility_expectations: ["Controls have labels", "Focus order follows layout"],
    console_check_required: true
  };
}

function backendTaskInput(overrides = {}) {
  return {
    goal_id: "G-000001",
    title: "Backend task",
    status: "ready",
    owner: "codex",
    reviewer: "claude",
    facet: "backend_api",
    objective: "Implement backend behavior.",
    acceptance_criteria: ["Backend behavior works"],
    allowed_paths: ["src/api/**"],
    forbidden_paths: ["src/ui/**"],
    proof: {
      commands: ["node --version"],
      requires_browser: false,
      requires_screenshot: false
    },
    ...overrides
  };
}

function frontendTaskInput(overrides = {}) {
  return {
    goal_id: "G-000001",
    title: "Frontend task",
    status: "ready",
    owner: "claude",
    reviewer: "codex",
    facet: "frontend_ui",
    objective: "Implement frontend behavior.",
    acceptance_criteria: ["Frontend behavior works"],
    allowed_paths: ["src/ui/**"],
    forbidden_paths: ["src/api/**"],
    proof: {
      commands: ["node --version"],
      requires_browser: true,
      requires_screenshot: true
    },
    frontend_contract: frontendContract(),
    ...overrides
  };
}

function passingManifest(taskId, overrides = {}) {
  return {
    task_id: taskId,
    tree_hash: "hash",
    merge_ref: "worktree",
    commands: [
      {
        cmd: "node --version",
        exit_code: 0,
        stdout: "logs/stdout.log",
        stderr: "logs/stderr.log"
      }
    ],
    artifacts: {
      browser_runs: [],
      screenshots: [],
      console_checks: []
    },
    waivers: [],
    verdict: "pass",
    ...overrides
  };
}

module.exports = {
  tempRoot,
  writeExecutable,
  installFakeBinary,
  withPathEnv,
  withFakeClaudeEnvironment,
  frontendContract,
  backendTaskInput,
  frontendTaskInput,
  passingManifest
};
