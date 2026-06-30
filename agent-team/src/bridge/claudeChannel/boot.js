const crypto = require("node:crypto");
const path = require("node:path");
const paths = require("../../paths");
const { appendJsonl, readJsonl } = require("../../fsutil");
const { appendMessage } = require("../../mailbox");

function now() {
  return new Date().toISOString();
}

function createLaunchId(name, projectDir) {
  const stable = crypto
    .createHash("sha256")
    .update(`${name || ""}\n${projectDir || ""}\n${Date.now()}\n${crypto.randomUUID()}`)
    .digest("hex")
    .slice(0, 10);
  return `launch_${Date.now().toString(36)}_${stable}`;
}

function normalizeRecord(input = {}) {
  return {
    launch_id: input.launch_id,
    name: input.name,
    project_dir: input.project_dir ? path.resolve(input.project_dir) : undefined,
    harness_cwd: input.harness_cwd ? path.resolve(input.harness_cwd) : undefined,
    source: input.source || "agent-team",
    mode: input.mode,
    pid: input.pid || process.pid,
    created_at: input.created_at || now()
  };
}

function recordLaunchMarker(cwd, input = {}) {
  if (!input.launch_id) throw new Error("--launch-id is required");
  const marker = normalizeRecord({
    ...input,
    harness_cwd: input.harness_cwd || cwd,
    source: input.source || "visible-launch-command"
  });
  appendJsonl(paths.channelLaunchMarkersPath(cwd), marker);
  return {
    ok: true,
    marker,
    launch_id: marker.launch_id,
    path: paths.channelLaunchMarkersPath(cwd)
  };
}

function recordBootAck(cwd, input = {}) {
  if (!input.launch_id) throw new Error("--launch-id is required");
  const ack = normalizeRecord({
    ...input,
    harness_cwd: input.harness_cwd || cwd,
    source: input.source || "claude-boot-ack"
  });
  ack.body = input.body || "ACK Agent Team quickstart loaded; mailbox is truth.";
  appendJsonl(paths.channelBootAcksPath(cwd), ack);
  const mailbox = appendMessage(cwd, {
    from: "claude",
    to: "codex",
    kind: "checkin",
    subject: `Claude boot ACK: ${ack.name || ack.launch_id}`,
    body: ack.body,
    metadata: {
      channel_boot_ack: true,
      launch_id: ack.launch_id,
      project_dir: ack.project_dir,
      source: ack.source
    }
  });
  return {
    ok: true,
    boot_ack: ack,
    launch_id: ack.launch_id,
    mailbox_message_id: mailbox.message.id,
    path: paths.channelBootAcksPath(cwd)
  };
}

function latestByLaunchId(file, launchId) {
  if (!launchId) return null;
  return readJsonl(file)
    .filter((row) => row.launch_id === launchId)
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .at(-1) || null;
}

function latestLaunchMarker(cwd, launchId) {
  return latestByLaunchId(paths.channelLaunchMarkersPath(cwd), launchId);
}

function latestBootAck(cwd, launchId) {
  return latestByLaunchId(paths.channelBootAcksPath(cwd), launchId);
}

function waitForRecord(readFn, cwd, launchId, timeoutMs = 0, pollMs = 100) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    const record = readFn(cwd, launchId);
    if (record) return { ok: true, record };
    if (timeoutMs <= 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(10, Math.min(pollMs, 250)));
  }
  return { ok: false, reason: "not_recorded", launch_id: launchId };
}

function waitForLaunchMarker(cwd, launchId, timeoutMs = 0, pollMs = 100) {
  return waitForRecord(latestLaunchMarker, cwd, launchId, timeoutMs, pollMs);
}

function waitForBootAck(cwd, launchId, timeoutMs = 0, pollMs = 100) {
  return waitForRecord(latestBootAck, cwd, launchId, timeoutMs, pollMs);
}

module.exports = {
  createLaunchId,
  latestBootAck,
  latestLaunchMarker,
  recordBootAck,
  recordLaunchMarker,
  waitForBootAck,
  waitForLaunchMarker
};
