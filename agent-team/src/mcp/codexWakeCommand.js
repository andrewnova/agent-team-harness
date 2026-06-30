#!/usr/bin/env node
const path = require("node:path");
const paths = require("../paths");
const { appendJsonl, ensureDir, readJson } = require("../fsutil");

function usage() {
  return "agent-team-codex-wake <payload-path>\n";
}

function deliveryLogPath(cwd) {
  return path.join(paths.codexMcpDir(cwd), "wake-deliveries.jsonl");
}

function recordWakeDelivery(payloadPath) {
  const absolutePayloadPath = path.resolve(payloadPath);
  const payload = readJson(absolutePayloadPath);
  const cwd = path.resolve(payload.cwd || process.cwd());
  const message = payload.message || {};
  const record = {
    delivery_id: `codex_wake_${message.id || Date.now()}`,
    created_at: new Date().toISOString(),
    result_state: "delivered_to_codex_wake_adapter",
    payload_path: path.relative(cwd, absolutePayloadPath),
    message_id: message.id,
    from: message.from,
    to: message.to,
    kind: message.kind,
    subject: message.subject
  };
  ensureDir(paths.codexMcpDir(cwd));
  appendJsonl(deliveryLogPath(cwd), record);
  return {
    ok: true,
    ...record,
    wake_deliveries_path: path.relative(cwd, deliveryLogPath(cwd))
  };
}

if (require.main === module) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    process.stderr.write(usage());
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(recordWakeDelivery(payloadPath))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  deliveryLogPath,
  recordWakeDelivery
};
