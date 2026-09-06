const fs = require("node:fs");
const jobs = require("./jobs");
const features = require("./features");
const native = require("./native");
const { createTransport } = require("./cmux");
const project = require("./project");

const usage = `agent-team --cwd <coordinator-root> team <command>
  status
  project create --title <name> | show
  project attach --workspace <uuid> --surface <uuid> [--title <name>]
  job create --json <file> | list | show <id>
  job launch <id> --max-active <n> [--codex-bin <path>] [--claude-bin <path>]
  job cancel <id> | read <id> | inbox <id>
  job wait <id> --until ready|stopped [--timeout-ms <1..60000>]
  job send <id> --json <file> | wake <id> --message <message-id>
  feature create --json <file>
  feature assemble <id> --json <file>
  feature snapshot <id> | check <id> | collect <id> | status <id>
  feature import-review <id> --job <review-job-id>
Run launch/wake from a terminal inside cmux. JSON assignments require explicit model IDs.
`;

async function main(args, root) {
  if (!args.length || args.includes("--help")) { process.stdout.write(usage); return 0; }
  const [entity, operation, id] = args;
  const value = (flag) => { const i = args.indexOf(flag); if (i < 0 || !args[i + 1]) throw new Error(`${flag} is required`); return args[i + 1]; };
  const json = () => JSON.parse(fs.readFileSync(value("--json"), "utf8"));
  let result;
  if (entity === "status") {
    result = { project: project.getProject(root), jobs: jobs.listJobs(root).map((job) => native.jobHealth(root, job)) };
  } else if (entity === "project") {
    if (operation === "show") result = project.getProject(root);
    else if (operation === "create") result = project.ensureProject(root, { title: value("--title") });
    else if (operation === "attach") result = project.attachProject(root, {
      workspace_id: value("--workspace"), surface_id: value("--surface"), ...(args.includes("--title") ? { title: value("--title") } : {})
    });
    else throw new Error("unknown team project operation");
  } else if (entity === "job") {
    if (operation === "create") result = jobs.createJob(root, json());
    else if (operation === "list") result = jobs.listJobs(root);
    else if (operation === "show") result = jobs.getJob(root, id);
    else if (operation === "wait") result = await native.waitForJob(root, id, {
      until: value("--until"), ...(args.includes("--timeout-ms") ? { timeout_ms: Number(value("--timeout-ms")) } : {})
    });
    else if (operation === "launch") result = native.launchJob(root, id, {
      max_active: Number(value("--max-active")),
      ...(args.includes("--codex-bin") ? { codex_bin: value("--codex-bin") } : {}),
      ...(args.includes("--claude-bin") ? { claude_bin: value("--claude-bin") } : {})
    });
    else {
      const job = jobs.getJob(root, id);
      if (operation === "cancel") result = jobs.cancelJob(root, id, job.attempt);
      else if (operation === "read") result = createTransport().readSession(job);
      else if (operation === "inbox") result = jobs.jobInbox(root, id, job.attempt);
      else if (operation === "send") {
        const message = jobs.sendJobMessage(root, { ...json(), from_job: id, from_attempt: job.attempt });
        try { result = { message, delivery: native.wakeMessage(root, message) }; } catch (error) { result = { message, delivery: { status: "failed", error: error.message } }; }
      } else if (operation === "wake") {
        const message = jobs.jobInbox(root, id, job.attempt).find((m) => m.id === value("--message"));
        if (!message) throw new Error("message not in current addressed inbox");
        result = native.wakeMessage(root, message);
      } else throw new Error("unknown team job operation");
    }
  } else if (entity === "feature") {
    if (operation === "create") result = features.createFeature(root, json());
    else if (operation === "assemble") result = features.assembleFeature(root, id, json());
    else if (operation === "snapshot") result = features.snapshotFeature(root, id);
    else if (operation === "check") result = features.runFeatureChecks(root, id);
    else if (operation === "status") result = native.acceptanceStatus(root, id);
    else if (operation === "collect") result = native.collectFeature(root, id);
    else if (operation === "import-review") result = native.importReview(root, id, value("--job"));
    else throw new Error("unknown team feature operation");
  } else throw new Error("unknown team command");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return (entity === "status" && result.jobs.some((job) => job.state === "blocked")) ||
    (operation === "wait" && !result.reached) || (["status", "collect"].includes(operation) && result.eligible === false) || (operation === "check" && result.status !== "completed") ? 1 : 0;
}

module.exports = { main, usage };
