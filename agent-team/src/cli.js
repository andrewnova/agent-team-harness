#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = require("./state");
const harnessPaths = require("./paths");
const { exists, readJson } = require("./fsutil");
const { transitionTask } = require("./transitions");
const { recordReview, requestReview, importReview } = require("./review");
const { saveProof, runProof, markDone, waiver } = require("./proof");
const { recordMerge } = require("./merge");
const { loadLeaseBook, claimLeasesForTask, releaseLeases, escalateLease } = require("./leases");
const { runBrowserProof } = require("./browserProof");
const { runComputerProof } = require("./computerProof");
const { finalCheck } = require("./finalCheck");
const { generateGoalReport, closeout } = require("./goalReport");
const { writeRetentionPolicy } = require("./retention");
const { awaitReply } = require("./waiter");
const { checkPort } = require("./portCheck");
const { recordQualityReview } = require("./quality");
const { createWorktree, worktreeStatus, snapshotWorktree, mergeWorktree, listWorktrees } = require("./worktrees");
const { recordMoa, loadMoa, listMoa } = require("./moa");
const { importAgentTeams, loadAgentTeamImport, listAgentTeamImports } = require("./agentTeams");
const { importCodexSubagents, loadCodexSubagentImport, listCodexSubagentImports } = require("./codexSubagents");
const { scanClaudeNotices, listNotices, loadNotice, ackNotice } = require("./claudeNotices");
const {
  refactorPrompt,
  postBuildRefactorOffer,
  recordRefactorOffer,
  startRefactorOffer,
  listRefactorOffers,
  loadRefactorOffer,
  importRefactorRecommendation,
  loadRefactorRecommendation,
  listRefactorRecommendations,
  compareRefactorRecommendations,
  listRefactorComparisons,
  taskifyRefactor
} = require("./refactorLoop");
const { recordCheckin, listCheckins, loadCheckin, ackCheckin } = require("./checkins");
const {
  recordFeedback,
  listFeedback,
  loadFeedback,
  recommendSelfHeal,
  requestToolChange,
  postGoalSelfHealOffer,
  selfHealContext,
  listSelfHealRecommendations,
  loadSelfHealRecommendation,
  decideSelfHealRecommendation,
  markSelfHealApplied
} = require("./feedback");
const { regenerate } = require("./projections");
const { evaluateHandoff } = require("./handoff");
const { storeReground, requestReground, importReground } = require("./reground");
const { savePlan, importClaudePlan, reconcilePlan, assertDevPromotionAllowed } = require("./plans");
const { createBridge } = require("./bridge");
const { cockpitSnapshot, renderCockpit } = require("./cockpit");
const database = require("./db");
const { daemonStatus, startDaemon, stopDaemon, runDaemon } = require("./daemon");
const {
  appendMessage,
  appendMessagesBatch,
  listMessages,
  loadMessage,
  ackMessage,
  compactMessage,
  mailboxDiagnostics,
  watchInbox
} = require("./mailbox");

function usage() {
  return `agent-team [--cwd <harness-root>] <command>

Commands:
  start [--name <name>] [--project-dir <path>] [--fresh-claude] [--allow-cross-project-reuse] [--daemon] [--no-daemon] [--no-ensure-claude] [--strict-claude] [channel ensure options]
  init
  config
  doctor [--fix] [--target <target>] [--smoke] [--smoke-timeout-ms <ms>]
  daemon start [--roles codex,claude] [--interval-ms <ms>] [--include-existing] [--force]
  daemon run [--roles codex,claude] [--interval-ms <ms>] [--include-existing] [--once]
  daemon status
  daemon stop [--reason <text>]
  goal new --title <title> --objective <objective>
  goal update <goal> [--title <title>] [--objective <objective>] [--status <status>]
  goal report [--goal <goal>] [--out <file>]
  run start --kind <kind> --title <title> [--goal <goal>] [--task <task>] [--owner <codex|claude|human>] [--mode <mode>] [--summary <text>] [--metadata-json <file>]
  run list [--status <status>] [--kind <kind>] [--goal <goal>] [--task <task>]
  run show <run-id>
  run complete <run-id> [--status complete|failed|cancelled] [--summary <text>] [--outcome <text>] [--evidence <text>]
  plan codex --goal <goal> (--text <text>|--file <file>)
  plan claude --goal <goal> (--prompt <text> [--adapter mailbox|mock|manual|claude-channel]|--file <file>|--text <text>)
  plan import-claude --goal <goal> [--request-id <id>]
  plan reconcile --goal <goal> (--text <text>|--file <file>)
  tasks create --json <file>
  promote-dev [--degraded-reason <reason>]
  claim <task> --owner <codex|claude>
  attempt <task> --json <file>
  review <task> --json <file>
  review request <task> [--adapter mailbox|mock|manual|claude-channel] [--target <target>] [--timeout-ms <ms>] [--prompt <text>]
  review import <task> [--request-id <id>]
  quality <task> --json <file>
  merge <task> [--ref <ref>] [--tree-hash <hash>] [--strategy <name>] [--note <text>]
  lease list
  lease release <task> [--reason <reason>]
  lease escalate <lease-id> [--reason <reason>]
  worktree create <task> [--base <ref>] [--branch <branch>] [--path <path>] [--reason <reason>] [--force]
  worktree status <task>
  worktree snapshot <task> [--message <message>]
  worktree merge <task>
  worktree list
  agent-teams import --json <file>
  agent-teams list [--task <task>]
  agent-teams show <import-id>
  codex-subagents import --json <file>
  codex-subagents list [--task <task>]
  codex-subagents show <import-id>
  notice scan [--project-dir <path>] [--dir <path>]
  notice list [--status <new|acknowledged|applied|rejected|archived>] [--task <task>] [--limit <n>]
  notice show <notice-id>
  notice ack <notice-id> [--status <acknowledged|applied|rejected|archived>] [--note <text>]
  checkin record --from <codex|claude|human> --summary <text> [--status active|busy|idle|blocked|done] [--goal <goal>] [--task <task>] [--run <run>] [--steer <text>]
  checkin list [--from <codex|claude|human>] [--ack-status <status>] [--goal <goal>] [--task <task>] [--run <run>] [--limit <n>]
  checkin show <checkin-id>
  checkin ack <checkin-id> [--status acknowledged|applied|rejected] [--note <text>]
  mailbox send --from <codex|claude|human> --to <codex|claude|human> [--id <id>] [--kind request|reply|notify|checkin|heartbeat|receipt_ack] [--subject <text>] [--body <text>|--file <path>] [--goal <goal>] [--task <task>] [--run <run>] [--request-id <id>] [--in-reply-to <id>] [--reply-required]
  mailbox send-batch --json <file>
  mailbox inbox --to <codex|claude|human> [--from <role>] [--kind <kind>] [--unacked] [--limit <n>]
  mailbox show <message-id>
  mailbox ack <message-id> [--by <codex|claude|human>] [--note <text>]
  mailbox watch --to <codex|claude|human> [--from <role>] [--kind <kind>] [--unacked] [--include-existing] [--once] [--interval-ms <ms>]
  await reply --request-id <id> [--from <role>] [--to <role>] [--task <task>] [--goal <goal>] [--timeout-ms <ms>] [--interval-ms <ms>] [--once]
  feedback record --text <text> [--source user|codex|claude] [--scope <scope>] [--goal <goal>] [--task <task>]
  feedback list [--source <source>] [--scope <scope>] [--goal <goal>] [--task <task>] [--limit <n>]
  feedback show <feedback-id>
  self-heal context [--source <source>] [--scope <scope>] [--goal <goal>] [--task <task>] [--limit <n>]
  self-heal recommend --recommendation <text> [--source codex|claude|human] [--surface <surface>] [--title <title>] [--reason <text>] [--goal <goal>] [--task <task>]
  self-heal request-change --from codex|claude|human --surface <cli|skill|plugin|docs|harness|tests|architecture> --request <text> [--title <title>] [--reason <text>] [--goal <goal>] [--task <task>]
  self-heal list [--status <status>] [--source <source>] [--scope <scope>] [--type <type>] [--goal <goal>] [--task <task>] [--limit <n>]
  self-heal show <recommendation-id>
  self-heal approve <recommendation-id> [--note <text>]
  self-heal reject <recommendation-id> [--note <text>]
  self-heal mark-applied <recommendation-id> [--note <text>] [--evidence <text>]
  refactor prompt [--goal <goal>] [--task <task>] [--scope <text>]
  refactor offer [--goal <goal>] [--task <task>] [--scope <text>] [--title <title>]
  refactor list [--status <status>] [--goal <goal>] [--task <task>] [--limit <n>]
  refactor show <offer-id>
  refactor start <offer-id> [--title <title>]
  refactor import --run <run> --source <codex|claude> --json <file>
  refactor recommendations [--run <run>] [--source <codex|claude>] [--limit <n>]
  refactor recommendation <recommendation-id>
  refactor compare --run <run> [--synthesis <text>]
  refactor comparisons [--run <run>] [--limit <n>]
  refactor taskify --run <run> [--goal <goal>] [--create] [--out <file>]
  moa record --json <file>
  moa list [--scope <scope>] [--subject <id>] [--kind <kind>]
  moa show <council-id>
  verify <task> --json <file>
  verify run <task> [--timeout-ms <ms>] [--browser-run <artifact>] [--screenshot <path>] [--console-check <artifact>] [--computer-run <artifact>] [--waive-browser <reason>] [--waive-screenshot <reason>] [--waive-console <reason>] [--waive-computer <reason>]
  verify browser <task> --url <url> [--viewport <WxH>] [--run-id <id>] [--wait-ms <ms>] [--screenshot-name <file>] [--script <file>] [--fake]
  verify computer <task> (--artifact <path>|--fake) [--app <name>] [--interaction <text>] [--note <text>] [--run-id <id>]
  verify final [--allow-empty]
  closeout [--goal <goal>] [--allow-empty] [--stop-daemon] [--out <file>]
  retention policy [--goal <goal>]
  port check --port <port> [--host <host>] [--next]
  done <task>
  handoff <task>
  reground <task> --json <file>
  reground request <task> [--adapter mailbox|mock|manual|claude-channel] [--target <target>] [--timeout-ms <ms>] [--prompt <text>]
  reground import <task> [--request-id <id>]
  events [--task <task>] [--goal <goal>] [--type <type>] [--limit <n>]
  db status
  db rebuild
  db query --sql <select>
  bridge <manual|mock|claude-channel> --kind <kind> --task <task> --prompt <text> [--target <target>] [--timeout-ms <ms>]
  channel install [--version <version>] [--tools-dir <path>] [--bin-dir <path>] [--mcp-scope user|local] [--no-setup-mcp] [--require-setup-mcp]
  channel list
  channel ensure [--name <name>] [--target <target>] [--project-dir <path>] [--fresh-claude] [--allow-cross-project-reuse] [--timeout-ms <ms>] [--poll-ms <ms>] [--launch-mode <codex-terminal|visible|pty|background>] [--codex-terminal-launcher <path>] [--visible-app <app>] [--plugin-dir <path>] [--effort <level>] [--permission-mode <mode>] [--smoke] [--smoke-timeout-ms <ms>] [--approved-channel] [--no-chrome]
  channel auth [login] [--claudeai|--console] [--email <email>] [--sso] [--timeout-ms <ms>]
  channel doctor [--fix] [--target <target>] [--smoke] [--smoke-timeout-ms <ms>]
  channel status [--target <target>]
  channel ask --kind <kind> --task <task> --prompt <text> [--target <target>] [--timeout-ms <ms>]
  channel dispatch --kind <kind> --task <task> --prompt <text> [--target <target>] [--timeout-ms <ms>] [--goal <goal>]
  channel steer --kind <kind> --task <task> (--prompt <text>|--file <path>) [--subject <text>] [--target <target>] [--timeout-ms <ms>] [--goal <goal>] [--raw-live]
  watch [--once] [--json] [--target <target>] [--limit <n>] [--interval-ms <ms>] [--no-live-channel]
  cockpit [--json] [--target <target>] [--limit <n>] [--no-live-channel]
  board
  validate
`;
}

function argValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function argValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function readJsonArg(args, cwd = process.cwd()) {
  const file = argValue(args, "--json");
  if (!file) throw new Error("--json <file> is required");
  return JSON.parse(fs.readFileSync(path.resolve(cwd, file), "utf8"));
}

function optionalJsonFile(args, name, cwd = process.cwd()) {
  const file = argValue(args, name);
  if (!file) return undefined;
  return JSON.parse(fs.readFileSync(path.resolve(cwd, file), "utf8"));
}

function textArg(cwd, args, inlineName, fileName, fallback = "") {
  const file = argValue(args, fileName);
  if (file) return fs.readFileSync(path.resolve(cwd, file), "utf8");
  return argValue(args, inlineName, fallback);
}

function optionalNumberArg(args, name) {
  const value = argValue(args, name);
  if (value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return number;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function statusCounts(items) {
  const counts = {};
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

function transitionAfterReview(cwd, taskId, review) {
  if (review.verdict !== "approve" && review.verdict !== "waived") {
    return {
      ok: true,
      skipped: true,
      reason: `review verdict ${review.verdict} keeps task in review`
    };
  }
  const task = state.loadTask(cwd, taskId);
  if (task.status === "merge" || task.status === "verifying") return { ok: true, task };
  return transitionTask(cwd, taskId, "merge");
}

function proofWaivers(args) {
  const rows = [];
  for (const reason of argValues(args, "--waive-browser")) rows.push(waiver("browser", reason));
  for (const reason of argValues(args, "--waive-screenshot")) rows.push(waiver("screenshot", reason));
  for (const reason of argValues(args, "--waive-console")) rows.push(waiver("console", reason));
  for (const reason of argValues(args, "--waive-computer")) rows.push(waiver("computer", reason));
  for (const reason of argValues(args, "--waive-proof-artifact")) rows.push(waiver("proof_artifact", reason));
  return rows;
}

function channelEnsureOptions(args) {
  return {
    name: argValue(args, "--name"),
    target: argValue(args, "--target"),
    project_dir: argValue(args, "--project-dir"),
    fresh_claude: hasFlag(args, "--fresh-claude"),
    allow_cross_project_reuse: hasFlag(args, "--allow-cross-project-reuse"),
    timeout_ms: optionalNumberArg(args, "--timeout-ms") || optionalNumberArg(args, "--ensure-timeout-ms"),
    poll_ms: optionalNumberArg(args, "--poll-ms"),
    start_timeout_ms: optionalNumberArg(args, "--start-timeout-ms"),
    launch_mode: argValue(args, "--launch-mode"),
    codex_terminal_launcher: argValue(args, "--codex-terminal-launcher"),
    visible_app: argValue(args, "--visible-app"),
    plugin_dir: argValue(args, "--plugin-dir"),
    effort: argValue(args, "--effort"),
    permission_mode: argValue(args, "--permission-mode"),
    smoke: hasFlag(args, "--smoke"),
    smoke_timeout_ms: optionalNumberArg(args, "--smoke-timeout-ms"),
    use_development_channel: hasFlag(args, "--use-development-channel") || !hasFlag(args, "--approved-channel"),
    chrome: !hasFlag(args, "--no-chrome")
  };
}

function channelAuthOptions(args) {
  return {
    login: args.includes("login"),
    console: hasFlag(args, "--console"),
    claudeai: !hasFlag(args, "--console"),
    email: argValue(args, "--email"),
    sso: hasFlag(args, "--sso"),
    timeout_ms: optionalNumberArg(args, "--timeout-ms")
  };
}

function channelInstallOptions(args) {
  return {
    version: argValue(args, "--version"),
    tools_dir: argValue(args, "--tools-dir"),
    bin_dir: argValue(args, "--bin-dir"),
    mcp_scope: argValue(args, "--mcp-scope", "user"),
    setup_mcp: !hasFlag(args, "--no-setup-mcp"),
    setup_mcp_required: hasFlag(args, "--require-setup-mcp")
  };
}

function channelDoctor(cwd, args) {
  const adapter = createBridge("claude-channel");
  const options = {
    target: argValue(args, "--target"),
    smoke: hasFlag(args, "--smoke"),
    smoke_timeout_ms: optionalNumberArg(args, "--smoke-timeout-ms")
  };
  let install = null;
  let result = adapter.diagnose(cwd, options);
  if (hasFlag(args, "--fix") && result.claude_channel_cli && !result.claude_channel_cli.ok) {
    install = adapter.install(cwd, channelInstallOptions(args));
    result = adapter.diagnose(cwd, options);
  }
  return {
    ...result,
    fix_attempted: Boolean(install),
    install
  };
}

function startClaude(cwd, args) {
  if (hasFlag(args, "--no-ensure-claude")) {
    return {
      ok: null,
      skipped: true,
      reason: "--no-ensure-claude"
    };
  }
  const adapter = createBridge("claude-channel");
  return adapter.ensure(cwd, channelEnsureOptions(args));
}

function redactChannelDiagnostics(value) {
  if (Array.isArray(value)) return value.map(redactChannelDiagnostics);
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.includes(".claude-channel/token")) return "[redacted-token-path]";
    return value;
  }
  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    if (["stdout", "token_path", "endpoints_path"].includes(key)) continue;
    redacted[key] = redactChannelDiagnostics(item);
  }
  return redacted;
}

function loadChannelSession(cwd) {
  const file = harnessPaths.channelSessionPath(cwd);
  return exists(file) ? redactChannelDiagnostics(readJson(file)) : null;
}

function compactLiveChannelResult(row) {
  if (!row) return null;
  const response = row.response || {};
  return {
    ok: response.result_state === "answered",
    request_id: row.request_id,
    channel_request_id: response.channel_request_id,
    target: response.target || row.target,
    result_state: response.result_state || row.result_state,
    status: response.status,
    note: response.note,
    error: response.error
  };
}

function extractGlobalCwd(argv, cwd) {
  const args = [...argv];
  const index = args.indexOf("--cwd");
  if (index === -1) return { argv: args, cwd };
  const value = args[index + 1];
  if (!value) throw new Error("--cwd requires <harness-root>");
  args.splice(index, 2);
  return {
    argv: args,
    cwd: path.resolve(cwd, value)
  };
}

function completedStatus(value) {
  return ["complete", "completed", "done"].includes(String(value || "").toLowerCase());
}

function singleGoalIdForFinal(cwd) {
  const goalIds = [...new Set(state.listTasks(cwd).map((task) => task.goal_id).filter(Boolean))];
  return goalIds.length === 1 ? goalIds[0] : undefined;
}

function batchFailureSelfHeal(cwd, result, input = {}) {
  return requestToolChange(cwd, {
    source: "codex",
    surface: "cli",
    goal_id: input.goal_id || input.goal,
    task_id: input.task_id || input.task,
    title: "Prevent brittle mailbox batch delivery",
    reason: "A mailbox batch delivery failed validation, append, or readback verification.",
    request: [
      `mailbox send-batch failed for batch ${result.batch_id || "unknown"} with ${result.failed} failure(s).`,
      "Keep multi-message delivery on the first-class batch command with an absolute CLI path plus --cwd, never hand-rolled shell loops or relative temporary cwd commands.",
      `Failures: ${JSON.stringify(result.failures).slice(0, 1200)}`
    ].join(" ")
  });
}

function semanticAckReplyCommand({ requestId, mailboxMessageId }) {
  return [
    "node agent-team/src/cli.js mailbox send",
    "--from claude",
    "--to codex",
    "--kind reply",
    `--request-id ${requestId}`,
    `--in-reply-to ${mailboxMessageId}`,
    '--subject "ACK: received"',
    '--body "<ACK: received. I will do X next. Answer/blocker: ...>"'
  ].join(" ");
}

function mailboxFirstInstruction(prompt) {
  return [
    "Mailbox-first protocol:",
    "- Reply through the mailbox, not only through complete_channel_request.",
    "- The receiver daemon may generate a quick receipt_ack; that only proves the inbox received it.",
    "- Your reply must acknowledge receipt, state what you will do next, and answer the question or name the blocker.",
    "- Use the message request_id/id as the reply key.",
    "",
    prompt
  ].join("\n");
}

function liveSteerPrompt(prompt, durable) {
  return [
    "A durable mailbox request has already been queued for this instruction.",
    "Do not rely only on complete_channel_request.",
    "A daemon-generated receipt_ack may arrive first; it is not the semantic reply.",
    "Send the semantic ACK/reply through the mailbox with this command shape:",
    semanticAckReplyCommand({
      requestId: durable.request_id,
      mailboxMessageId: durable.mailbox_message_id
    }),
    "",
    "Required reply content:",
    "- ACK that you received the instruction.",
    "- State what you are going to do next.",
    "- Answer the question, or name the blocker and what you need.",
    "",
    prompt
  ].join("\n");
}

function channelSessionForStart(cwd, claudeStartup) {
  if (claudeStartup && claudeStartup.ok === false) return null;
  if (claudeStartup && claudeStartup.skipped) return null;
  return loadChannelSession(cwd);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function watchOptions(args) {
  return {
    event_limit: optionalNumberArg(args, "--limit") || 8,
    target: argValue(args, "--target"),
    live_channel: !hasFlag(args, "--no-live-channel")
  };
}

function runWatch(cwd, args, { once }) {
  const json = hasFlag(args, "--json");
  const intervalMs = optionalNumberArg(args, "--interval-ms") || 2000;
  do {
    const snapshot = cockpitSnapshot(cwd, watchOptions(args));
    if (json) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderCockpit(snapshot)}\n`);
    }
    if (once) return 0;
    sleepMs(intervalMs);
    process.stdout.write("\n");
  } while (true);
}

async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const resolved = extractGlobalCwd(argv, cwd);
  argv = resolved.argv;
  cwd = resolved.cwd;
  const [command, subcommand, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return 0;
  }
  if (command === "init") {
    print(state.init(cwd));
    return 0;
  }
  if (command === "config") {
    state.init(cwd);
    print(state.loadConfig(cwd));
    return 0;
  }
  if (command === "doctor") {
    const result = channelDoctor(cwd, argv.slice(1));
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "daemon" && subcommand === "status") {
    print(daemonStatus(cwd));
    return 0;
  }
  if (command === "daemon" && subcommand === "start") {
    print(
      startDaemon(cwd, {
        entrypoint: __filename,
        roles: argValue(rest, "--roles"),
        interval_ms: optionalNumberArg(rest, "--interval-ms"),
        include_existing: hasFlag(rest, "--include-existing"),
        force: hasFlag(rest, "--force")
      })
    );
    return 0;
  }
  if (command === "daemon" && subcommand === "run") {
    const result = runDaemon(cwd, {
      roles: argValue(rest, "--roles"),
      interval_ms: optionalNumberArg(rest, "--interval-ms"),
      include_existing: hasFlag(rest, "--include-existing"),
      once: hasFlag(rest, "--once"),
      onOutput: (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)
    });
    if (hasFlag(rest, "--once")) print(result);
    return result && typeof result.then === "function" ? result : 0;
  }
  if (command === "daemon" && subcommand === "stop") {
    print(stopDaemon(cwd, { reason: argValue(rest, "--reason") }));
    return 0;
  }
  if (command === "start") {
    const startArgs = argv.slice(1);
    const initResult = state.init(cwd);
    const root = initResult.root;
    const config = initResult.config || state.loadConfig(cwd);
    const claudeStartup = startClaude(cwd, startArgs);
    const shouldStartDaemon = !hasFlag(startArgs, "--no-daemon") && (hasFlag(startArgs, "--daemon") || process.env.AGENT_TEAM_START_DAEMON === "1");
    const receiver = shouldStartDaemon
      ? startDaemon(cwd, {
          entrypoint: __filename,
          roles: argValue(startArgs, "--daemon-roles", "codex,claude"),
          interval_ms: optionalNumberArg(startArgs, "--daemon-interval-ms") || 1000,
          include_existing: true
        })
      : {
          ok: true,
          action: "status_only",
          auto_start: false,
          recommended_command: "daemon start --roles codex,claude --include-existing",
          status: daemonStatus(cwd)
        };
    const goals = state.listGoals(cwd);
    const tasks = state.listTasks(cwd);
    print({
      root,
      operator: "codex",
      execution_profile: config.execution_profile,
      acceleration: {
        token_budget: config.token_budget,
        codex_native_subagents: config.codex_native_subagents,
        claude_agent_teams: config.claude_agent_teams,
        parallelism_policy: config.parallelism_policy
      },
      claude_channel_startup: claudeStartup,
      claude_channel: channelSessionForStart(cwd, claudeStartup),
      receiver_daemon: receiver,
      prompt_user: goals.length === 0 && tasks.length === 0,
      question: "Do you want Planning Mode or Dev Mode?",
      modes: [
        {
          id: "planning",
          label: "Planning Mode",
          use_when: "starting a new project, unclear scope, or needing Codex and Claude to shape the plan before tasks exist",
          next_command: "goal new"
        },
        {
          id: "dev",
          label: "Dev Mode",
          use_when: "tasks already exist or the user wants execution, review, proof, handoff, and done gates now",
          next_command: "watch"
        }
      ],
      state: {
        goals: goals.length,
        tasks: tasks.length,
        task_statuses: statusCounts(tasks)
      }
    });
    return hasFlag(startArgs, "--strict-claude") && claudeStartup && claudeStartup.ok === false ? 1 : 0;
  }
  if (command === "goal" && subcommand === "new") {
    print(
      state.createGoal(cwd, {
        title: argValue(rest, "--title", "Untitled goal"),
        objective: argValue(rest, "--objective", "No objective recorded")
      })
    );
    return 0;
  }
  if (command === "goal" && subcommand === "update") {
    const goalId = rest[0];
    if (!goalId) throw new Error("goal update requires <goal>");
    const updateArgs = rest.slice(1);
    const updated = state.updateGoal(cwd, goalId, {
      title: argValue(updateArgs, "--title"),
      objective: argValue(updateArgs, "--objective"),
      status: argValue(updateArgs, "--status")
    });
    print({
      ...updated,
      ...(completedStatus(updated.status)
        ? { post_goal_self_heal_offer: postGoalSelfHealOffer(cwd, { goal_id: goalId, source: "goal update" }) }
        : {})
    });
    return 0;
  }
  if (command === "goal" && subcommand === "report") {
    print(
      generateGoalReport(cwd, {
        goal_id: argValue(rest, "--goal"),
        out: argValue(rest, "--out")
      })
    );
    return 0;
  }
  if (command === "run" && subcommand === "start") {
    print(
      state.createRun(cwd, {
        kind: argValue(rest, "--kind", "manual"),
        title: argValue(rest, "--title", "Untitled coordination run"),
        goal_id: argValue(rest, "--goal"),
        task_id: argValue(rest, "--task"),
        owner: argValue(rest, "--owner", "codex"),
        mode: argValue(rest, "--mode"),
        summary: argValue(rest, "--summary", ""),
        metadata: optionalJsonFile(rest, "--metadata-json", cwd)
      })
    );
    return 0;
  }
  if (command === "run" && subcommand === "list") {
    print({
      ok: true,
      runs: state.listRuns(cwd, {
        status: argValue(rest, "--status"),
        kind: argValue(rest, "--kind"),
        goal_id: argValue(rest, "--goal"),
        task_id: argValue(rest, "--task")
      })
    });
    return 0;
  }
  if (command === "run" && subcommand === "show") {
    const runId = rest[0];
    if (!runId) throw new Error("run show requires <run-id>");
    print({ ok: true, run: state.loadRun(cwd, runId) });
    return 0;
  }
  if (command === "run" && subcommand === "complete") {
    const runId = rest[0];
    if (!runId) throw new Error("run complete requires <run-id>");
    const evidence = argValues(rest, "--evidence");
    print(
      state.completeRun(cwd, runId, {
        status: argValue(rest, "--status", "complete"),
        summary: argValue(rest, "--summary"),
        outcome: argValue(rest, "--outcome"),
        evidence: evidence.length ? evidence : undefined
      })
    );
    return 0;
  }
  if (command === "plan" && subcommand === "codex") {
    print(
      savePlan(cwd, {
        goal_id: argValue(rest, "--goal", "G-000000"),
        author: "codex",
        body: argValue(rest, "--text"),
        file: argValue(rest, "--file")
      })
    );
    return 0;
  }
  if (command === "plan" && subcommand === "claude") {
    const claudePlanFile = argValue(rest, "--file");
    const claudePlanText = argValue(rest, "--text");
    if (claudePlanFile || claudePlanText) {
      print(
        savePlan(cwd, {
          goal_id: argValue(rest, "--goal", "G-000000"),
          author: "claude",
          body: claudePlanText,
          file: claudePlanFile,
          metadata: {
            Source: claudePlanFile ? "durable-file-import" : "manual-text-import"
          }
        })
      );
      return 0;
    }
    const adapterName = argValue(rest, "--adapter", "mailbox");
    const adapter = createBridge(adapterName);
    const row = adapter.request(cwd, {
      task_id: argValue(rest, "--goal", "G-000000"),
      kind: "plan_review",
      prompt: argValue(rest, "--prompt", "Please review this plan."),
      target: argValue(rest, "--target"),
      timeout_ms: optionalNumberArg(rest, "--timeout-ms")
    });
    print(row);
    return 0;
  }
  if (command === "plan" && subcommand === "import-claude") {
    print(
      importClaudePlan(cwd, {
        goal_id: argValue(rest, "--goal", "G-000000"),
        request_id: argValue(rest, "--request-id")
      })
    );
    return 0;
  }
  if (command === "plan" && subcommand === "reconcile") {
    print(
      reconcilePlan(cwd, {
        goal_id: argValue(rest, "--goal", "G-000000"),
        body: argValue(rest, "--text"),
        file: argValue(rest, "--file")
      })
    );
    return 0;
  }
  if (command === "tasks" && subcommand === "create") {
    print(state.createTask(cwd, readJsonArg(rest, cwd)));
    return 0;
  }
  if (command === "promote-dev") {
    const promoteArgs = argv.slice(1);
    const degradedReason = argValue(promoteArgs, "--degraded-reason");
    const tasks = state.listTasks(cwd);
    const planningTasks = tasks.filter((task) => task.status === "planning");
    const planning = {};
    for (const goalId of [...new Set(planningTasks.map((task) => task.goal_id))]) {
      planning[goalId] = assertDevPromotionAllowed(cwd, goalId, degradedReason);
    }
    const promoted = [];
    for (const task of planningTasks) {
      if (task.status === "planning") {
        const result = transitionTask(cwd, task.task_id, "ready");
        if (!result.ok) throw new Error(result.errors.join("; "));
        promoted.push(task.task_id);
      }
    }
    print({ ok: true, promoted, planning });
    return 0;
  }
  if (command === "claim") {
    const taskId = subcommand;
    const owner = argValue(rest, "--owner");
    if (owner) state.changeOwner(cwd, taskId, owner, argValue(rest, "--reason"));
    const task = state.loadTask(cwd, taskId);
    const lease = claimLeasesForTask(cwd, task, {
      reason: argValue(rest, "--reason", "task claimed")
    });
    if (!lease.ok) {
      print({ ok: false, lease });
      return 1;
    }
    const transition = transitionTask(cwd, taskId, "claimed");
    if (!transition.ok && lease.action === "claimed") releaseLeases(cwd, taskId, "claim transition failed");
    print({ ok: transition.ok, lease, transition });
    return transition.ok ? 0 : 1;
  }
  if (command === "attempt") {
    const attempt = { ...readJsonArg(rest, cwd), task_id: subcommand };
    state.recordAttempt(cwd, attempt);
    const task = state.loadTask(cwd, subcommand);
    if (task.status === "claimed") transitionTask(cwd, subcommand, "implementing");
    if (state.loadTask(cwd, subcommand).status === "implementing") transitionTask(cwd, subcommand, "review");
    print(attempt);
    return 0;
  }
  if (command === "review" && subcommand === "request") {
    const taskId = rest[0];
    if (!taskId) throw new Error("review request requires <task>");
    print(
      requestReview(cwd, taskId, {
        adapter: argValue(rest, "--adapter", "mailbox"),
        target: argValue(rest, "--target"),
        timeout_ms: optionalNumberArg(rest, "--timeout-ms"),
        prompt: argValue(rest, "--prompt")
      })
    );
    return 0;
  }
  if (command === "review" && subcommand === "import") {
    const taskId = rest[0];
    if (!taskId) throw new Error("review import requires <task>");
    const imported = importReview(cwd, taskId, {
      request_id: argValue(rest, "--request-id")
    });
    const transition = transitionAfterReview(cwd, taskId, imported.review);
    print({ ...imported, transition });
    return transition.ok ? 0 : 1;
  }
  if (command === "review") {
    const review = { ...readJsonArg(rest, cwd), task_id: subcommand };
    recordReview(cwd, review);
    const transition = transitionAfterReview(cwd, subcommand, review);
    print({ ok: transition.ok, review, transition });
    return transition.ok ? 0 : 1;
  }
  if (command === "quality") {
    const review = { ...readJsonArg(rest, cwd), task_id: subcommand };
    print(recordQualityReview(cwd, review));
    return 0;
  }
  if (command === "merge") {
    const result = recordMerge(cwd, subcommand, {
      merge_ref: argValue(rest, "--ref"),
      tree_hash: argValue(rest, "--tree-hash"),
      strategy: argValue(rest, "--strategy"),
      note: argValue(rest, "--note")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "lease" && subcommand === "list") {
    print(loadLeaseBook(cwd));
    return 0;
  }
  if (command === "lease" && subcommand === "release") {
    const taskId = rest[0];
    if (!taskId) throw new Error("lease release requires <task>");
    print(releaseLeases(cwd, taskId, argValue(rest, "--reason", "manual release")));
    return 0;
  }
  if (command === "lease" && subcommand === "escalate") {
    const leaseId = rest[0];
    if (!leaseId) throw new Error("lease escalate requires <lease-id>");
    const result = escalateLease(cwd, leaseId, argValue(rest, "--reason", "manual escalation"));
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "worktree" && subcommand === "create") {
    const taskId = rest[0];
    if (!taskId) throw new Error("worktree create requires <task>");
    const result = createWorktree(cwd, taskId, {
      base_ref: argValue(rest, "--base"),
      branch: argValue(rest, "--branch"),
      path: argValue(rest, "--path"),
      reason: argValue(rest, "--reason"),
      force: hasFlag(rest, "--force"),
      timeout_ms: optionalNumberArg(rest, "--timeout-ms")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "worktree" && subcommand === "status") {
    const taskId = rest[0];
    if (!taskId) throw new Error("worktree status requires <task>");
    const result = worktreeStatus(cwd, taskId);
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "worktree" && subcommand === "snapshot") {
    const taskId = rest[0];
    if (!taskId) throw new Error("worktree snapshot requires <task>");
    const result = snapshotWorktree(cwd, taskId, {
      message: argValue(rest, "--message"),
      timeout_ms: optionalNumberArg(rest, "--timeout-ms")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "worktree" && subcommand === "merge") {
    const taskId = rest[0];
    if (!taskId) throw new Error("worktree merge requires <task>");
    const result = mergeWorktree(cwd, taskId, {
      timeout_ms: optionalNumberArg(rest, "--timeout-ms")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "worktree" && subcommand === "list") {
    print({ ok: true, worktrees: listWorktrees(cwd) });
    return 0;
  }
  if (command === "agent-teams" && subcommand === "import") {
    print(importAgentTeams(cwd, readJsonArg(rest, cwd)));
    return 0;
  }
  if (command === "agent-teams" && subcommand === "list") {
    print({
      ok: true,
      imports: listAgentTeamImports(cwd, {
        task_id: argValue(rest, "--task")
      })
    });
    return 0;
  }
  if (command === "agent-teams" && subcommand === "show") {
    const importId = rest[0];
    if (!importId) throw new Error("agent-teams show requires <import-id>");
    const record = loadAgentTeamImport(cwd, importId);
    print(record ? { ok: true, import: record } : { ok: false, error: `Agent Teams import not found: ${importId}` });
    return record ? 0 : 1;
  }
  if (command === "codex-subagents" && subcommand === "import") {
    print(importCodexSubagents(cwd, readJsonArg(rest, cwd)));
    return 0;
  }
  if (command === "codex-subagents" && subcommand === "list") {
    print({
      ok: true,
      imports: listCodexSubagentImports(cwd, {
        task_id: argValue(rest, "--task")
      })
    });
    return 0;
  }
  if (command === "codex-subagents" && subcommand === "show") {
    const importId = rest[0];
    if (!importId) throw new Error("codex-subagents show requires <import-id>");
    const record = loadCodexSubagentImport(cwd, importId);
    print(record ? { ok: true, import: record } : { ok: false, error: `Codex subagents import not found: ${importId}` });
    return record ? 0 : 1;
  }
  if (command === "notice" && subcommand === "scan") {
    print(scanClaudeNotices(cwd, {
      project_dir: argValue(rest, "--project-dir"),
      dirs: argValues(rest, "--dir")
    }));
    return 0;
  }
  if (command === "notice" && subcommand === "list") {
    print({
      ok: true,
      notices: listNotices(cwd, {
        status: argValue(rest, "--status"),
        task_id: argValue(rest, "--task"),
        limit: optionalNumberArg(rest, "--limit"),
        include_archived: true
      })
    });
    return 0;
  }
  if (command === "notice" && subcommand === "show") {
    const noticeId = rest[0];
    if (!noticeId) throw new Error("notice show requires <notice-id>");
    const notice = loadNotice(cwd, noticeId);
    print(notice ? { ok: true, notice } : { ok: false, error: `Claude notice not found: ${noticeId}` });
    return notice ? 0 : 1;
  }
  if (command === "notice" && subcommand === "ack") {
    const noticeId = rest[0];
    if (!noticeId) throw new Error("notice ack requires <notice-id>");
    const result = ackNotice(cwd, noticeId, {
      status: argValue(rest, "--status", "acknowledged"),
      note: argValue(rest, "--note", "")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "checkin" && subcommand === "record") {
    print(
      recordCheckin(cwd, {
        from: argValue(rest, "--from", "claude"),
        status: argValue(rest, "--status", "active"),
        goal_id: argValue(rest, "--goal"),
        task_id: argValue(rest, "--task"),
        run_id: argValue(rest, "--run"),
        summary: argValue(rest, "--summary", ""),
        steer: argValue(rest, "--steer", "")
      })
    );
    return 0;
  }
  if (command === "checkin" && subcommand === "list") {
    print({
      ok: true,
      checkins: listCheckins(cwd, {
        agent: argValue(rest, "--from"),
        ack_status: argValue(rest, "--ack-status"),
        goal_id: argValue(rest, "--goal"),
        task_id: argValue(rest, "--task"),
        run_id: argValue(rest, "--run"),
        limit: optionalNumberArg(rest, "--limit")
      })
    });
    return 0;
  }
  if (command === "checkin" && subcommand === "show") {
    const checkinId = rest[0];
    if (!checkinId) throw new Error("checkin show requires <checkin-id>");
    const checkin = loadCheckin(cwd, checkinId);
    print(checkin ? { ok: true, checkin } : { ok: false, error: `agent check-in not found: ${checkinId}` });
    return checkin ? 0 : 1;
  }
  if (command === "checkin" && subcommand === "ack") {
    const checkinId = rest[0];
    if (!checkinId) throw new Error("checkin ack requires <checkin-id>");
    const result = ackCheckin(cwd, checkinId, {
      status: argValue(rest, "--status", "acknowledged"),
      note: argValue(rest, "--note", "")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "mailbox" && subcommand === "send") {
    const result = appendMessage(cwd, {
      id: argValue(rest, "--id"),
      from: argValue(rest, "--from", "claude"),
      to: argValue(rest, "--to", "codex"),
      kind: argValue(rest, "--kind", "notify"),
      subject: argValue(rest, "--subject", ""),
      body: argValue(rest, "--body", ""),
      file: argValue(rest, "--file"),
      goal_id: argValue(rest, "--goal"),
      task_id: argValue(rest, "--task"),
      run_id: argValue(rest, "--run"),
      request_id: argValue(rest, "--request-id"),
      in_reply_to: argValue(rest, "--in-reply-to"),
      reply_required: hasFlag(rest, "--reply-required")
    });
    print(result);
    return 0;
  }
  if (command === "mailbox" && subcommand === "send-batch") {
    const input = readJsonArg(rest, cwd);
    const result = appendMessagesBatch(cwd, input);
    const output = { ...result };
    if (!result.ok) {
      try {
        output.self_heal_recommendation = batchFailureSelfHeal(cwd, result, input);
      } catch (error) {
        output.self_heal_error = error.message;
      }
    }
    print(output);
    return result.ok ? 0 : 1;
  }
  if (command === "mailbox" && (subcommand === "inbox" || subcommand === "list")) {
    const filter = {
      to: argValue(rest, "--to", subcommand === "inbox" ? "codex" : null),
      from: argValue(rest, "--from"),
      kind: argValue(rest, "--kind"),
      task_id: argValue(rest, "--task"),
      goal_id: argValue(rest, "--goal"),
      run_id: argValue(rest, "--run"),
      request_id: argValue(rest, "--request-id"),
      in_reply_to: argValue(rest, "--in-reply-to"),
      unacked: hasFlag(rest, "--unacked"),
      limit: optionalNumberArg(rest, "--limit")
    };
    const diagnostics = mailboxDiagnostics(cwd);
    print({
      ok: diagnostics.malformed_total === 0,
      diagnostics,
      messages: listMessages(cwd, filter).map(compactMessage)
    });
    return 0;
  }
  if (command === "mailbox" && subcommand === "show") {
    const messageId = rest[0];
    if (!messageId) throw new Error("mailbox show requires <message-id>");
    const message = loadMessage(cwd, messageId, { include_body: true });
    print(message ? { ok: true, message } : { ok: false, error: `mailbox message not found: ${messageId}` });
    return message ? 0 : 1;
  }
  if (command === "mailbox" && subcommand === "ack") {
    const messageId = rest[0];
    if (!messageId) throw new Error("mailbox ack requires <message-id>");
    const result = ackMessage(cwd, messageId, {
      by: argValue(rest, "--by"),
      note: argValue(rest, "--note", "")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "mailbox" && subcommand === "watch") {
    const watchArgs = rest;
    const existing = listMessages(cwd, {
      to: argValue(watchArgs, "--to", "codex"),
      from: argValue(watchArgs, "--from"),
      kind: argValue(watchArgs, "--kind"),
      task_id: argValue(watchArgs, "--task"),
      goal_id: argValue(watchArgs, "--goal"),
      run_id: argValue(watchArgs, "--run"),
      unacked: hasFlag(watchArgs, "--unacked"),
      limit: optionalNumberArg(watchArgs, "--limit")
    }).map(compactMessage);
    if (hasFlag(watchArgs, "--once")) {
      const diagnostics = mailboxDiagnostics(cwd);
      print({ ok: diagnostics.malformed_total === 0, diagnostics, messages: existing });
      return 0;
    }
    if (hasFlag(watchArgs, "--include-existing") && existing.length) {
      const diagnostics = mailboxDiagnostics(cwd);
      process.stdout.write(`${JSON.stringify({ ok: diagnostics.malformed_total === 0, diagnostics, messages: existing })}\n`);
    }
    const watcher = watchInbox(
      cwd,
      {
        to: argValue(watchArgs, "--to", "codex"),
        from: argValue(watchArgs, "--from"),
        kind: argValue(watchArgs, "--kind"),
        task_id: argValue(watchArgs, "--task"),
        goal_id: argValue(watchArgs, "--goal"),
        run_id: argValue(watchArgs, "--run"),
        unacked: hasFlag(watchArgs, "--unacked"),
        include_existing: false,
        interval_ms: optionalNumberArg(watchArgs, "--interval-ms") || 1000
      },
      (messages) => {
        const diagnostics = mailboxDiagnostics(cwd);
        process.stdout.write(
          `${JSON.stringify({ ok: diagnostics.malformed_total === 0, diagnostics, messages: messages.map(compactMessage) })}\n`
        );
      }
    );
    process.on("SIGINT", () => {
      watcher.close();
      process.exit(0);
    });
    return new Promise(() => {});
  }
  if (command === "await" && subcommand === "reply") {
    const result = await awaitReply(cwd, {
      request_id: argValue(rest, "--request-id"),
      from: argValue(rest, "--from", "claude"),
      to: argValue(rest, "--to", "codex"),
      task_id: argValue(rest, "--task"),
      goal_id: argValue(rest, "--goal"),
      run_id: argValue(rest, "--run"),
      timeout_ms: optionalNumberArg(rest, "--timeout-ms"),
      interval_ms: optionalNumberArg(rest, "--interval-ms"),
      once: hasFlag(rest, "--once")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "feedback" && subcommand === "record") {
    print(
      recordFeedback(cwd, {
        source: argValue(rest, "--source", "user"),
        scope: argValue(rest, "--scope", "harness"),
        goal_id: argValue(rest, "--goal"),
        task_id: argValue(rest, "--task"),
        text: argValue(rest, "--text", "")
      })
    );
    return 0;
  }
  if (command === "feedback" && subcommand === "list") {
    print({
      ok: true,
      feedback: listFeedback(cwd, {
        source: argValue(rest, "--source"),
        scope: argValue(rest, "--scope"),
        goal_id: argValue(rest, "--goal"),
        task_id: argValue(rest, "--task"),
        limit: optionalNumberArg(rest, "--limit")
      })
    });
    return 0;
  }
  if (command === "feedback" && subcommand === "show") {
    const feedbackId = rest[0];
    if (!feedbackId) throw new Error("feedback show requires <feedback-id>");
    const feedback = loadFeedback(cwd, feedbackId);
    print(feedback ? { ok: true, feedback } : { ok: false, error: `feedback not found: ${feedbackId}` });
    return feedback ? 0 : 1;
  }
  if (command === "self-heal" && subcommand === "recommend") {
    print(
      recommendSelfHeal(cwd, {
        source: argValue(rest, "--source"),
        target_surface: argValue(rest, "--surface"),
        scope: argValue(rest, "--scope"),
        title: argValue(rest, "--title"),
        reason: argValue(rest, "--reason"),
        recommendation: argValue(rest, "--recommendation"),
        goal_id: argValue(rest, "--goal"),
        task_id: argValue(rest, "--task")
      })
    );
    return 0;
  }
  if (command === "self-heal" && subcommand === "request-change") {
    print(
      requestToolChange(cwd, {
        source: argValue(rest, "--from", "claude"),
        target_surface: argValue(rest, "--surface", "harness"),
        title: argValue(rest, "--title"),
        reason: argValue(rest, "--reason"),
        request: argValue(rest, "--request"),
        goal_id: argValue(rest, "--goal"),
        task_id: argValue(rest, "--task")
      })
    );
    return 0;
  }
  if (command === "self-heal" && subcommand === "context") {
    print(
      selfHealContext(cwd, {
        source: argValue(rest, "--source"),
        scope: argValue(rest, "--scope"),
        goal_id: argValue(rest, "--goal"),
        task_id: argValue(rest, "--task"),
        limit: optionalNumberArg(rest, "--limit")
      })
    );
    return 0;
  }
  if (command === "self-heal" && subcommand === "list") {
    print({
      ok: true,
      recommendations: listSelfHealRecommendations(cwd, {
        status: argValue(rest, "--status"),
        source: argValue(rest, "--source"),
        scope: argValue(rest, "--scope"),
        type: argValue(rest, "--type"),
        goal_id: argValue(rest, "--goal"),
        task_id: argValue(rest, "--task"),
        limit: optionalNumberArg(rest, "--limit")
      })
    });
    return 0;
  }
  if (command === "self-heal" && subcommand === "show") {
    const recommendationId = rest[0];
    if (!recommendationId) throw new Error("self-heal show requires <recommendation-id>");
    const recommendation = loadSelfHealRecommendation(cwd, recommendationId);
    print(recommendation ? { ok: true, recommendation } : { ok: false, error: `self-heal recommendation not found: ${recommendationId}` });
    return recommendation ? 0 : 1;
  }
  if (command === "self-heal" && (subcommand === "approve" || subcommand === "reject")) {
    const recommendationId = rest[0];
    if (!recommendationId) throw new Error(`self-heal ${subcommand} requires <recommendation-id>`);
    const result = decideSelfHealRecommendation(cwd, recommendationId, {
      decision: subcommand === "approve" ? "approved" : "rejected",
      note: argValue(rest, "--note", "")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "self-heal" && subcommand === "mark-applied") {
    const recommendationId = rest[0];
    if (!recommendationId) throw new Error("self-heal mark-applied requires <recommendation-id>");
    const result = markSelfHealApplied(cwd, recommendationId, {
      note: argValue(rest, "--note", ""),
      evidence: argValue(rest, "--evidence", "")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "refactor" && subcommand === "prompt") {
    const prompt = refactorPrompt({
      goal_id: argValue(rest, "--goal"),
      task_id: argValue(rest, "--task"),
      scope: argValue(rest, "--scope")
    });
    print({ ok: true, prompt, prompt_sha256: require("node:crypto").createHash("sha256").update(prompt).digest("hex") });
    return 0;
  }
  if (command === "refactor" && subcommand === "offer") {
    print(
      recordRefactorOffer(cwd, {
        goal_id: argValue(rest, "--goal"),
        task_id: argValue(rest, "--task"),
        scope: argValue(rest, "--scope"),
        title: argValue(rest, "--title")
      })
    );
    return 0;
  }
  if (command === "refactor" && subcommand === "list") {
    print({
      ok: true,
      offers: listRefactorOffers(cwd, {
        status: argValue(rest, "--status"),
        goal_id: argValue(rest, "--goal"),
        task_id: argValue(rest, "--task"),
        limit: optionalNumberArg(rest, "--limit")
      })
    });
    return 0;
  }
  if (command === "refactor" && subcommand === "show") {
    const offerId = rest[0];
    if (!offerId) throw new Error("refactor show requires <offer-id>");
    const offer = loadRefactorOffer(cwd, offerId);
    print(offer ? { ok: true, offer } : { ok: false, error: `refactor offer not found: ${offerId}` });
    return offer ? 0 : 1;
  }
  if (command === "refactor" && subcommand === "start") {
    const offerId = rest[0];
    if (!offerId) throw new Error("refactor start requires <offer-id>");
    const result = startRefactorOffer(cwd, offerId, {
      title: argValue(rest, "--title")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "refactor" && subcommand === "import") {
    const input = readJsonArg(rest, cwd);
    print(
      importRefactorRecommendation(cwd, {
        ...input,
        run_id: argValue(rest, "--run", input.run_id),
        source: argValue(rest, "--source", input.source)
      })
    );
    return 0;
  }
  if (command === "refactor" && subcommand === "recommendations") {
    print({
      ok: true,
      recommendations: listRefactorRecommendations(cwd, {
        run_id: argValue(rest, "--run"),
        source: argValue(rest, "--source"),
        limit: optionalNumberArg(rest, "--limit")
      })
    });
    return 0;
  }
  if (command === "refactor" && subcommand === "recommendation") {
    const recommendationId = rest[0];
    if (!recommendationId) throw new Error("refactor recommendation requires <recommendation-id>");
    const recommendation = loadRefactorRecommendation(cwd, recommendationId);
    print(recommendation ? { ok: true, recommendation } : { ok: false, error: `refactor recommendation not found: ${recommendationId}` });
    return recommendation ? 0 : 1;
  }
  if (command === "refactor" && subcommand === "compare") {
    const runId = argValue(rest, "--run");
    if (!runId) throw new Error("refactor compare requires --run <run>");
    print(
      compareRefactorRecommendations(cwd, {
        run_id: runId,
        synthesis: argValue(rest, "--synthesis")
      })
    );
    return 0;
  }
  if (command === "refactor" && subcommand === "comparisons") {
    print({
      ok: true,
      comparisons: listRefactorComparisons(cwd, {
        run_id: argValue(rest, "--run"),
        limit: optionalNumberArg(rest, "--limit")
      })
    });
    return 0;
  }
  if (command === "refactor" && subcommand === "taskify") {
    const runId = argValue(rest, "--run");
    if (!runId) throw new Error("refactor taskify requires --run <run>");
    const result = taskifyRefactor(cwd, {
      run_id: runId,
      goal_id: argValue(rest, "--goal"),
      create: hasFlag(rest, "--create")
    });
    const outFile = argValue(rest, "--out");
    if (outFile) {
      fs.writeFileSync(path.resolve(process.cwd(), outFile), `${JSON.stringify(result.proposed_tasks, null, 2)}\n`);
      result.out = path.resolve(process.cwd(), outFile);
    }
    print(result);
    return 0;
  }
  if (command === "moa" && subcommand === "record") {
    print(recordMoa(cwd, readJsonArg(rest, cwd)));
    return 0;
  }
  if (command === "moa" && subcommand === "list") {
    print({
      ok: true,
      councils: listMoa(cwd, {
        scope: argValue(rest, "--scope"),
        subject_id: argValue(rest, "--subject"),
        kind: argValue(rest, "--kind")
      })
    });
    return 0;
  }
  if (command === "moa" && subcommand === "show") {
    const councilId = rest[0];
    if (!councilId) throw new Error("moa show requires <council-id>");
    const council = loadMoa(cwd, councilId);
    print(council ? { ok: true, council } : { ok: false, error: `moa council not found: ${councilId}` });
    return council ? 0 : 1;
  }
  if (command === "verify" && subcommand === "browser") {
    const taskId = rest[0];
    if (!taskId) throw new Error("verify browser requires <task>");
    const result = await runBrowserProof(cwd, taskId, {
      url: argValue(rest, "--url"),
      viewport: argValue(rest, "--viewport", "1280x720"),
      run_id: argValue(rest, "--run-id"),
      wait_ms: optionalNumberArg(rest, "--wait-ms"),
      screenshot_name: argValue(rest, "--screenshot-name"),
      script: argValue(rest, "--script"),
      fake: hasFlag(rest, "--fake"),
      timeout_ms: optionalNumberArg(rest, "--timeout-ms")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "verify" && subcommand === "computer") {
    const taskId = rest[0];
    if (!taskId) throw new Error("verify computer requires <task>");
    const result = runComputerProof(cwd, taskId, {
      artifact: argValue(rest, "--artifact"),
      app: argValue(rest, "--app"),
      interaction: argValue(rest, "--interaction"),
      note: argValue(rest, "--note"),
      run_id: argValue(rest, "--run-id"),
      fake: hasFlag(rest, "--fake")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "verify" && subcommand === "final") {
    const result = finalCheck(cwd, {
      allow_empty: hasFlag(rest, "--allow-empty")
    });
    const goalId = singleGoalIdForFinal(cwd);
    print(
      result.ok
        ? {
            ...result,
            post_build_refactor_offer: postBuildRefactorOffer(cwd, { goal_id: goalId, source: "verify final" }),
            post_goal_self_heal_offer: postGoalSelfHealOffer(cwd, { goal_id: goalId, source: "verify final" })
          }
        : result
    );
    return result.ok ? 0 : 1;
  }
  if (command === "closeout") {
    const result = closeout(cwd, {
      goal_id: argValue(rest, "--goal"),
      allow_empty: hasFlag(rest, "--allow-empty"),
      stop_daemon: hasFlag(rest, "--stop-daemon"),
      out: argValue(rest, "--out")
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "retention" && subcommand === "policy") {
    print(
      writeRetentionPolicy(cwd, {
        goal_id: argValue(rest, "--goal")
      })
    );
    return 0;
  }
  if (command === "port" && subcommand === "check") {
    const result = await checkPort({
      port: argValue(rest, "--port"),
      host: argValue(rest, "--host"),
      next: hasFlag(rest, "--next")
    });
    print(result);
    return 0;
  }
  if (command === "verify" && subcommand === "run") {
    const taskId = rest[0];
    if (!taskId) throw new Error("verify run requires <task>");
    const result = runProof(cwd, taskId, {
      timeout_ms: optionalNumberArg(rest, "--timeout-ms"),
      browser_runs: argValues(rest, "--browser-run"),
      screenshots: argValues(rest, "--screenshot"),
      console_checks: argValues(rest, "--console-check"),
      computer_runs: argValues(rest, "--computer-run"),
      waivers: proofWaivers(rest)
    });
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "verify") {
    const manifest = { ...readJsonArg(rest, cwd), task_id: subcommand };
    print(saveProof(cwd, manifest));
    return 0;
  }
  if (command === "done") {
    const result = markDone(cwd, subcommand);
    const leases = result.ok ? releaseLeases(cwd, subcommand, "task done") : null;
    print({
      ...result,
      leases,
      ...(result.ok
        ? {
            post_build_refactor_offer: postBuildRefactorOffer(cwd, { task_id: subcommand, source: "done" }),
            post_goal_self_heal_offer: postGoalSelfHealOffer(cwd, {
              goal_id: result.task.goal_id,
              task_id: subcommand,
              source: "done"
            })
          }
        : {})
    });
    return result.ok ? 0 : 1;
  }
  if (command === "handoff") {
    print(evaluateHandoff(cwd, subcommand));
    return 0;
  }
  if (command === "reground" && subcommand === "request") {
    const taskId = rest[0];
    if (!taskId) throw new Error("reground request requires <task>");
    print(
      requestReground(cwd, taskId, {
        adapter: argValue(rest, "--adapter", "mailbox"),
        target: argValue(rest, "--target"),
        timeout_ms: optionalNumberArg(rest, "--timeout-ms"),
        prompt: argValue(rest, "--prompt")
      })
    );
    return 0;
  }
  if (command === "reground" && subcommand === "import") {
    const taskId = rest[0];
    if (!taskId) throw new Error("reground import requires <task>");
    const imported = importReground(cwd, taskId, {
      request_id: argValue(rest, "--request-id")
    });
    print(imported);
    return imported.ok ? 0 : 1;
  }
  if (command === "reground") {
    const packet = { ...readJsonArg(rest, cwd), task_id: subcommand };
    const result = storeReground(cwd, packet);
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "events") {
    const eventArgs = argv.slice(1);
    print({
      events: state.listEvents(cwd, {
        task_id: argValue(eventArgs, "--task"),
        goal_id: argValue(eventArgs, "--goal"),
        type: argValue(eventArgs, "--type"),
        limit: optionalNumberArg(eventArgs, "--limit")
      })
    });
    return 0;
  }
  if (command === "db" && subcommand === "status") {
    print(database.status(cwd));
    return 0;
  }
  if (command === "db" && subcommand === "rebuild") {
    print(database.rebuildDatabase(cwd));
    return 0;
  }
  if (command === "db" && subcommand === "query") {
    print(database.query(cwd, argValue(rest, "--sql")));
    return 0;
  }
  if (command === "watch") {
    const watchArgs = argv.slice(1);
    return runWatch(cwd, watchArgs, { once: hasFlag(watchArgs, "--once") });
  }
  if (command === "cockpit") {
    const cockpitArgs = argv.slice(1);
    return runWatch(cwd, cockpitArgs, { once: true });
  }
  if (command === "bridge") {
    const adapter = createBridge(subcommand);
    const row = adapter.request(cwd, {
      task_id: argValue(rest, "--task", "T-000000"),
      kind: argValue(rest, "--kind", "debug_help"),
      prompt: argValue(rest, "--prompt", ""),
      target: argValue(rest, "--target"),
      timeout_ms: optionalNumberArg(rest, "--timeout-ms")
    });
    print(row);
    return 0;
  }
  if (command === "channel" && subcommand === "install") {
    const adapter = createBridge("claude-channel");
    const result = adapter.install(cwd, channelInstallOptions(rest));
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "channel" && subcommand === "status") {
    const adapter = createBridge("claude-channel");
    print(adapter.status(argValue(rest, "--target"), cwd));
    return 0;
  }
  if (command === "channel" && subcommand === "list") {
    const adapter = createBridge("claude-channel");
    print(adapter.list(cwd));
    return 0;
  }
  if (command === "channel" && subcommand === "auth") {
    const adapter = createBridge("claude-channel");
    const result = adapter.auth(cwd, channelAuthOptions(rest));
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "channel" && subcommand === "doctor") {
    const result = channelDoctor(cwd, rest);
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "channel" && subcommand === "ensure") {
    const adapter = createBridge("claude-channel");
    const result = adapter.ensure(cwd, channelEnsureOptions(rest));
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "channel" && subcommand === "ask") {
    const adapter = createBridge("claude-channel");
    const row = adapter.request(cwd, {
      task_id: argValue(rest, "--task", "T-000000"),
      kind: argValue(rest, "--kind", "debug_help"),
      prompt: argValue(rest, "--prompt", ""),
      target: argValue(rest, "--target"),
      timeout_ms: optionalNumberArg(rest, "--timeout-ms")
    });
    print(row);
    return 0;
  }
  if (command === "channel" && subcommand === "dispatch") {
    const adapter = createBridge("mailbox");
    const row = adapter.request(cwd, {
      task_id: argValue(rest, "--task", "T-000000"),
      goal_id: argValue(rest, "--goal"),
      kind: argValue(rest, "--kind", "implementation"),
      prompt: argValue(rest, "--prompt", ""),
      target: argValue(rest, "--target"),
      timeout_ms: optionalNumberArg(rest, "--timeout-ms"),
      subject: argValue(rest, "--subject")
    });
    print({
      ok: true,
      nonblocking: true,
      request: row,
      next: {
        codex: "continue working; watch mailbox/cockpit for Claude replies and check-ins",
        claude: "reply with mailbox send --from claude --to codex --kind reply --in-reply-to <request-id>"
      }
    });
    return 0;
  }
  if (command === "channel" && subcommand === "steer") {
    const prompt = textArg(cwd, rest, "--prompt", "--file", "");
    const taskId = argValue(rest, "--task", "T-000000");
    const kind = argValue(rest, "--kind", "implementation");
    const target = argValue(rest, "--target");
    const timeoutMs = optionalNumberArg(rest, "--timeout-ms") || 60000;
    const mailbox = createBridge("mailbox");
    const durable = mailbox.request(cwd, {
      task_id: taskId,
      goal_id: argValue(rest, "--goal"),
      kind,
      prompt: mailboxFirstInstruction(prompt),
      target,
      timeout_ms: timeoutMs,
      subject: argValue(rest, "--subject") || `Claude steering ${taskId}`,
      reply_required: true
    });
    let live = {
      ok: false,
      skipped: true,
      reason: "daemon-live-wake"
    };
    if (hasFlag(rest, "--raw-live")) {
      try {
        const liveAdapter = createBridge("claude-channel");
        live = compactLiveChannelResult(
          liveAdapter.request(cwd, {
            task_id: taskId,
            goal_id: argValue(rest, "--goal"),
            kind,
            prompt: liveSteerPrompt(prompt, durable),
            target,
            timeout_ms: timeoutMs
          })
        );
      } catch (error) {
        live = {
          ok: false,
          skipped: false,
          error: error.message
        };
      }
    }
    print({
      ok: true,
      durable_ack: {
        request_id: durable.request_id,
        mailbox_message_id: durable.mailbox_message_id,
        reply_required: true,
        dispatch_state: durable.dispatch_state
      },
      live_channel: live,
      next: {
        codex: "continue working; watch mailbox/cockpit for Claude ACKs, replies, and check-ins",
        claude: `reply with mailbox send --from claude --to codex --kind reply --request-id ${durable.request_id} --in-reply-to ${durable.mailbox_message_id} --body <answer>`
      }
    });
    return 0;
  }
  if (command === "board") {
    print(regenerate(cwd));
    return 0;
  }
  if (command === "validate") {
    const tasks = state.listTasks(cwd);
    for (const task of tasks) state.saveTask(cwd, task);
    const dbStatus = database.status(cwd);
    const dbResult = dbStatus.needs_rebuild ? database.rebuildDatabase(cwd) : dbStatus;
    print({ ok: true, tasks: tasks.length, events: state.listEvents(cwd).length, db: dbResult });
    return 0;
  }
  throw new Error(`unknown command: ${argv.join(" ")}`);
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    });
}

module.exports = { main };
