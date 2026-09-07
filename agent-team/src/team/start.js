const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const jobs = require("./jobs");
const native = require("./native");
const { getProject, ensureProject } = require("./project");
const { createTransport } = require("./cmux");
const { shellQuote } = require("../bridge/claudeChannel/utils");
const runtimePolicy = require("../../native-team.config.json");
const tasks = require("./tasks");
const { withLock } = require("./lock");
const { atomicJson } = require("./atomicJson");

const usage = `Start a native coding team from a terminal inside cmux.
  node scripts/start-team.js --project /absolute/path/to/repo [options]

  --leader codex|claude       Lead runtime (default: codex)
  --max-active 4              Top-level harness jobs, including the lead; excludes native child agents
  --coordinator /path         Separate state directory (default: ~/.local/state/agent-team/cmux/<project-id>)
  --codex-bin /path/to/codex   Override the Codex executable found in PATH
  --claude-bin /path/to/claude Override the Claude executable found in PATH
  --codex-model gpt-6-astra    Explicit Codex model
  --claude-model claude-fable-5-1[1m]  Explicit Claude model
  --task-file /path           Persist this UTF-8 task and deliver it to the lead
  --task-id identifier        Retry key (default: hash of the exact task content)
  --resume-task               Explicitly resume an unfinished task on a replacement lead
  --help                     Show this help without changing anything

Repeated startup reports the existing lead's health and repairs a missing owned controller; it never opens a duplicate lead.
Native agents are enabled: Astra uses xhigh; Fable uses medium with Claude Code Agent Teams.
Model access, native trust, login and approval prompts remain with the native CLIs.
`;

function executable(value, env) {
  const candidates = path.isAbsolute(value) ? [value] : (env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir, value));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`Executable not found: ${value}. Install it or pass its absolute --codex-bin/--claude-bin path.`);
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || "Git command failed");
  return result.stdout.trim();
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function leadPrompt(config, id) {
  const cli = [process.execPath, path.resolve(__dirname, "../cli.js"), "--cwd", config.coordinator, "team"].map(shellQuote).join(" ");
  const launch = ["--max-active", String(config.max_active), "--codex-bin", config.codex_bin, "--claude-bin", config.claude_bin].map(shellQuote).join(" ");
  return `You are the interactive ${config.leader} lead for the user's repository ${config.project}. Your job ID is ${id}.
First report ready, read team_inbox and read ${path.resolve(__dirname, "../../../docs/cmux-team.md")}. Tell the user which project you are ready to work on. Operator tasks arrive in team_inbox with metadata.origin=operator_task. Before beginning a submitted task, call team_reply to acknowledge it. An acknowledged task is already underway; repeated inbox reads or wakes never authorize duplicate assignments. On a resumed task, inspect previous_deliveries and the durable feature/job state before continuing any unfinished work. Finish with team_reply task_status=completed and your result; this keeps the lead available. If no task is pending, wait without inventing work. End idle turns normally and keep the native session available for direct steering and worker replies.

Use the native team CLI: ${cli}
Launch ready top-level harness jobs with: job launch <id> ${launch}
You are the only owner of top-level assignments, repair decisions and feature acceptance. Create worker jobs through the CLI. Every job may use native child agents; the top-level cap includes you but does not count those children. Refill useful capacity as jobs finish. Use as many native agents as can usefully work in parallel for both coding and reviewing, within native CLI and account limits. Fable uses medium effort with native Claude Code Agent Teams; Astra always uses xhigh. Each parent owns child scopes, permission boundaries, isolated concurrent writes, result synthesis and shutdown.

Backend work and fixes use runtime codex, model ${config.codex_model}. Frontend work and fixes use runtime claude, model ${config.claude_model}. Required independent reviewers are fresh instances of the opposite lead runtime. Use explicit model IDs and never silently substitute a model. Missing or interrupted reviews do not count as approval.

Read the project's AGENTS.md and follow the user's authorized scope. Define a brief and meaningful checks. Create the feature worktree and private writer checkouts outside this coordinator; feature create defaults to a sibling worktree directory. Keep this checkout for coordination only; do not implement in the user's main checkout. Assemble worker commits, freeze the full feature, run checks alongside independent reviews, then use feature collect <id> to import every stopped required review and see pending jobs, findings and acceptance together. Collect again on a job_stopped wake; unchanged imports are idempotent. Batch justified repairs. Source changes require current reviews and checks. Eligibility does not authorize merging or deployment.

All top-level worker and reviewer results must address ${id} through the team MCP mailbox. Native children return findings through their parent's native agent messaging and must not impersonate their parent's harness job. The mailbox stores the message; a cmux wake only asks the receiver to read its inbox. Use semantic replies as evidence of communication. Do not stop yourself while worker replies are outstanding. Preserve state and terminal evidence, and verify that cancelled processes stop before reusing their writer claims. Native sandbox and approval boundaries remain in force. Do not merge, publish, contact others or delete unrelated data without authority from the user's task. Follow the target repository's commit conventions. Do not report terminal completion merely because you are waiting for user input.`;
}

function start(values, { platform = process.platform, env = process.env, home = os.homedir(), transport = createTransport() } = {}) {
  if (platform !== "darwin") throw new Error("Native cmux startup currently requires macOS.");
  if (!env.CMUX_WORKSPACE_ID) throw new Error("Run this command from a terminal inside cmux.");
  if (!values.project || !path.isAbsolute(values.project)) throw new Error("--project must be an absolute path to an existing Git repository.");
  const project = fs.realpathSync(git(["-C", values.project, "rev-parse", "--show-toplevel"]));
  const leader = values.leader || "codex";
  if (!["codex", "claude"].includes(leader)) throw new Error("--leader must be codex or claude.");
  const max_active = Number(values["max-active"] || 4);
  if (!Number.isSafeInteger(max_active) || max_active < 2) throw new Error("--max-active must be an integer of at least 2, including the lead.");
  const slug = path.basename(project).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "project";
  const key = `${slug}-${crypto.createHash("sha256").update(project).digest("hex").slice(0, 12)}`;
  const requested = values.coordinator || path.join(home, ".local", "state", "agent-team", "cmux", key);
  if (!path.isAbsolute(requested)) throw new Error("--coordinator must be an absolute directory.");
  const directory = path.resolve(requested);
  if (contains(project, directory) || contains(directory, project)) throw new Error("The coordinator must be separate from the project checkout, not inside it or an ancestor of it.");
  const config = {
    project, coordinator: directory, leader, max_active, runtime_policy: runtimePolicy,
    codex_bin: executable(values["codex-bin"] || "codex", env),
    claude_bin: executable(values["claude-bin"] || "claude", env),
    codex_model: values["codex-model"] || "gpt-6-astra",
    claude_model: values["claude-model"] || "claude-fable-5-1[1m]"
  };
  for (const model of [config.codex_model, config.claude_model]) if (!model.trim() || model.includes("\0")) throw new Error("Model IDs must be non-empty strings without NUL.");
  let submission;
  if (values["task-file"]) {
    if (!path.isAbsolute(values["task-file"])) throw new Error("--task-file must be an absolute file path");
    const body = fs.readFileSync(values["task-file"], "utf8");
    const id = values["task-id"] || `task-${crypto.createHash("sha256").update(body).digest("hex").slice(0, 32)}`;
    tasks.validate(id, body);
    submission = { id, body };
  } else if (values["task-id"] || values["resume-task"]) throw new Error("--task-id and --resume-task require --task-file");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== directory) throw new Error("Coordinator paths must not use symlink aliases.");
  // The lead is a writer in this directory. Give it its own checkout boundary
  // so an enclosing repository cannot become its writer claim.
  if (!fs.existsSync(path.join(directory, ".git"))) {
    if (fs.readdirSync(directory).length) throw new Error("Refusing to initialize a nonempty coordinator; choose an empty directory.");
    git(["init", "--initial-branch=codex/team-coordinator", directory]);
    fs.writeFileSync(path.join(directory, ".gitignore"), ".agent-team/\n", { flag: "wx" });
  }
  if (fs.realpathSync(git(["rev-parse", "--show-toplevel"], directory)) !== directory) throw new Error("The coordinator must be its own Git root.");
  const state = path.join(directory, ".agent-team");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(state) !== state) throw new Error("Coordinator state must not be aliased.");
  const lock = path.join(state, "start.lock");
  return withLock(lock, () => {
    let all = jobs.listJobs(directory);
    const configFile = path.join(state, "start.json");
    if (all.some((job) => ["launching", "running", "cancelling"].includes(job.status) || (job.role === "lead" && job.status === "queued"))) {
      const saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
      if (JSON.stringify(saved) !== JSON.stringify(config)) throw new Error("Active or queued jobs use a different startup configuration. Finish or cancel those jobs before changing it.");
    }
    // Commit the caller's task before any native session can start. A retry
    // repairs an interrupted launch using this same immutable submission.
    if (submission) jobs.submitTask(directory, submission);
    const handoff = (lead) => {
      const pending = jobs.listTasks(directory).filter((task) => task.status !== "completed" || task.id === submission?.id);
      if (!pending.length) return {};
      const summaries = pending.map((task) => {
        const result = jobs.assignTask(directory, task.id, lead.id, { resume: task.id === submission?.id && Boolean(values["resume-task"]) });
        let delivery;
        if (result.state === "submitted" && lead.status !== "queued") {
          try {
            const message = jobs.jobInbox(directory, lead.id, lead.attempt).find((row) => row.task_id === task.id);
            delivery = native.wakeMessage(directory, message, transport);
          } catch (error) { delivery = { status: "failed", error: error.message }; }
        }
        return { ...tasks.summary(directory, result), ...(delivery ? { wake: delivery } : {}) };
      });
      return { tasks: summaries, ...(submission ? { task: summaries.find((task) => task.id === submission.id) } : {}) };
    };
    for (const job of all.filter((job) => job.role === "lead" && job.status === "launching")) jobs.recoverUnlaunchedJob(directory, job.id);
    all = jobs.listJobs(directory);
    const active = all.filter((job) => ["launching", "running", "cancelling"].includes(job.status));
    if (active.length) {
      const lead = active.find((job) => job.role === "lead");
      if (!lead) throw new Error("Jobs from the previous lead are still active. Finish or cancel them before starting a new lead.");
      let controllerError;
      if (lead.workspace_id && lead.status !== "cancelling") {
        try {
          const anchor = getProject(directory);
          if (!anchor || anchor.workspace_id !== lead.workspace_id) throw new Error("The active lead has no matching persisted cmux project.");
          ensureProject(directory, { transport });
        } catch (error) {
          controllerError = error;
        }
      }
      let health = native.jobHealth(directory, lead, { transport });
      if (controllerError && ["ready", "starting", "blocked"].includes(health.state)) {
        health = { ...health, ready: false, state: "blocked", note: `Controller unavailable: ${controllerError.message}. ${health.note}` };
      }
      return { coordinator: directory, project, reused: true, job: jobs.getJob(directory, lead.id), ...health, ...handoff(lead) };
    }
    const queued = all.filter((job) => job.role === "lead" && job.status === "queued");
    if (queued.length > 1) throw new Error("Multiple queued leads require inspection before startup");
    if (!queued.length) atomicJson(configFile, config);
    const id = queued[0]?.id || `lead-${crypto.randomUUID().slice(0, 8)}`;
    if (!queued.length) jobs.createJob(directory, { id, leader, role: "lead", model: config[`${leader}_model`], cwd: directory, writable: true, prompt: leadPrompt(config, id), dependencies: [] });
    const task = handoff(jobs.getJob(directory, id));
    const job = native.launchJob(directory, id, { max_active, codex_bin: config.codex_bin, claude_bin: config.claude_bin, transport, project_title: `Team · ${path.basename(project)}` });
    const health = native.jobHealth(directory, job, { transport });
    return { coordinator: directory, project, reused: false, job: jobs.getJob(directory, job.id), ...health, ...task };
  });
}

function main(args) {
  try {
    const options = Object.fromEntries(["project", "leader", "max-active", "coordinator", "codex-bin", "claude-bin", "codex-model", "claude-model", "task-file", "task-id"].map((name) => [name, { type: "string" }]));
    const { values } = parseArgs({ args, options: { ...options, help: { type: "boolean" }, "resume-task": { type: "boolean" } }, allowPositionals: false });
    if (values.help) { process.stdout.write(usage); return; }
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 13)) throw new Error("Node.js >=22.13.0 is required.");
    const result = start(values);
    if (result.state === "blocked" || result.tasks?.some((task) => task.state === "resume_required")) process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({ ...result, job: { id: result.job.id, runtime: result.job.runtime, model: result.job.model, status: result.job.status, ready_at: result.job.ready_at, workspace_id: result.job.workspace_id, surface_id: result.job.surface_id } }, null, 2)}\n`);
  } catch (error) { process.stderr.write(`Startup failed: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { main, start, leadPrompt };
