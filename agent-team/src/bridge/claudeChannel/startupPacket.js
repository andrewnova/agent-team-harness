const path = require("node:path");
const paths = require("../../paths");
const { readJson, readJsonl, writeText } = require("../../fsutil");
const { appendMessage } = require("../../mailbox");
const { recordBootAck } = require("./boot");
const { shellQuote } = require("./utils");

function latestSessionForLaunch(cwd, launchId) {
  const current = (() => {
    try {
      return readJson(paths.channelSessionPath(cwd));
    } catch (_error) {
      return null;
    }
  })();
  const history = readJsonl(paths.channelSessionsPath(cwd)).filter((row) => row.launch_id === launchId);
  const matches = [current, ...history].filter((row) => row && row.launch_id === launchId);
  return matches
    .sort((a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")))
    .at(-1) || null;
}

function cliCommand(cwd) {
  const cliPath = path.resolve(__dirname, "..", "..", "cli.js");
  return `${shellQuote(process.execPath)} ${shellQuote(cliPath)} --cwd ${shellQuote(cwd)}`;
}

function bootAckCommand(cwd, session) {
  return [
    cliCommand(cwd),
    "channel",
    "boot-ack",
    "--launch-id",
    shellQuote(session.launch_id),
    "--name",
    shellQuote(session.name || session.target || "claude"),
    "--project-dir",
    shellQuote(session.project_dir || cwd)
  ].join(" ");
}

function packetText(cwd, session) {
  const projectDir = session.project_dir || cwd;
  const harnessRoot = session.harness_cwd || cwd;
  return [
    "# Agent Team Claude Startup Recovery Packet",
    "",
    "From Codex to Claude",
    "",
    `Project: ${projectDir}`,
    `Harness root: ${harnessRoot}`,
    `Session name: ${session.name || session.target || "(unknown)"}`,
    `Launch id: ${session.launch_id}`,
    "",
    "## What I Need From You",
    "",
    "1. Run the exact boot ACK command below once.",
    "2. Visibly say: ACK Agent Team quickstart loaded; mailbox is truth.",
    "3. Stay in this visible Claude session for Codex steering.",
    "",
    "## Boot ACK Command",
    "",
    "```bash",
    bootAckCommand(cwd, session),
    "```",
    "",
    "## Do Not Change",
    "",
    "- Do not edit project files just to acknowledge startup.",
    "- Do not mark task state, review, merge, proof, or done gates yourself.",
    "- Do not use raw complete_channel_request as the durable reply path.",
    "",
    "## Relevant Files And Context",
    "",
    `- Startup quickstart: ${path.join(harnessRoot, ".agent-team", "teammate-quickstart.md")}`,
    `- Mailbox: ${paths.mailboxPath(harnessRoot)}`,
    `- Claude startup session record: ${paths.channelSessionPath(harnessRoot)}`,
    `- Cockpit command: ${cliCommand(harnessRoot)} watch --once --no-live-channel`,
    "",
    "## Reply Required",
    "",
    "Running the boot ACK command is the reply. If it fails, send a mailbox check-in or paste the error back to Codex so the harness can import the failure without losing state."
  ].join("\n");
}

function createStartupPacket(cwd, input = {}) {
  const launchId = input.launch_id || input.session?.launch_id;
  if (!launchId) throw new Error("--launch-id is required");
  const session = {
    ...(latestSessionForLaunch(cwd, launchId) || {}),
    ...(input.session || {}),
    launch_id: launchId
  };
  const text = packetText(cwd, session);
  const file = paths.channelStartupPacketPath(cwd, launchId);
  writeText(file, text);
  return {
    ok: true,
    launch_id: launchId,
    path: file,
    relative_path: path.relative(cwd, file),
    command: `channel startup-packet --launch-id ${launchId} --text`,
    text: input.include_text ? text : undefined
  };
}

function looksLikeBootAck(body) {
  const text = String(body || "").trim();
  if (!text) return false;
  if (/failed|failure|error|blocked|could not|can't|cannot/i.test(text)) return false;
  return /^ACK\b/i.test(text) || /ACK Agent Team quickstart loaded/i.test(text) || /mailbox is truth/i.test(text);
}

function importStartupReply(cwd, input = {}) {
  const launchId = input.launch_id;
  if (!launchId) throw new Error("--launch-id is required");
  const body = String(input.body || "").trim();
  if (!body) throw new Error("--text or --file is required");
  const session = {
    ...(latestSessionForLaunch(cwd, launchId) || {}),
    launch_id: launchId
  };
  const name = input.name || session.name || session.target || launchId;
  const projectDir = input.project_dir || session.project_dir || cwd;
  const kind = input.kind || (input.request_id || input.in_reply_to ? "reply" : "checkin");
  if (!["checkin", "reply"].includes(kind)) throw new Error("--kind must be checkin or reply");
  if (kind === "reply" && !(input.request_id || input.in_reply_to)) {
    throw new Error("--kind reply requires --request-id or --in-reply-to");
  }
  const metadata = {
    channel_startup_import: true,
    launch_id: launchId,
    project_dir: path.resolve(projectDir),
    startup_packet_path: paths.channelStartupPacketPath(cwd, launchId)
  };
  if (input.boot_ack || looksLikeBootAck(body)) {
    const ack = recordBootAck(cwd, {
      launch_id: launchId,
      name,
      project_dir: projectDir,
      harness_cwd: session.harness_cwd || cwd,
      body,
      source: "startup-import",
      kind,
      task_id: input.task_id,
      goal_id: input.goal_id,
      run_id: input.run_id,
      request_id: input.request_id,
      in_reply_to: input.in_reply_to,
      metadata
    });
    return {
      ok: true,
      mode: "boot_ack",
      launch_id: launchId,
      mailbox_message_id: ack.mailbox_message_id,
      request_id: input.request_id,
      in_reply_to: input.in_reply_to,
      boot_ack: ack.boot_ack,
      path: ack.path
    };
  }
  const result = appendMessage(cwd, {
    from: "claude",
    to: "codex",
    kind,
    subject: input.subject || `Claude startup ${kind === "reply" ? "reply" : "check-in"}: ${name}`,
    body,
    task_id: input.task_id,
    goal_id: input.goal_id,
    run_id: input.run_id,
    request_id: input.request_id,
    in_reply_to: input.in_reply_to,
    metadata
  });
  return {
    ok: true,
    mode: kind,
    launch_id: launchId,
    mailbox_message_id: result.message.id,
    request_id: input.request_id,
    in_reply_to: input.in_reply_to,
    message: result.message
  };
}

module.exports = {
  bootAckCommand,
  createStartupPacket,
  importStartupReply,
  latestSessionForLaunch,
  packetText
};
