const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempRoot } = require("./helpers");
const { appendMessage, listMessages, loadMessage } = require("../src/mailbox");
const { attemptCodexPush } = require("../src/daemon");
const {
  MCP_SERVER_NAME,
  initializeResult,
  toolDefinitions,
  watchMailbox,
  callTool
} = require("../src/mcp/codexChannel");
const { encodeFrame, decodeFrames } = require("../src/mcp/claudeServer");

function parseToolResponse(response) {
  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, "text");
  return JSON.parse(response.content[0].text);
}

test("Codex MCP channel declares mailbox wake and reply tools", () => {
  const init = initializeResult({ version: "test" });
  assert.equal(init.serverInfo.name, MCP_SERVER_NAME);
  assert.match(init.instructions, /mailbox-first/i);
  assert.match(init.instructions, /wake payloads are delivery projections/i);

  assert.deepEqual(
    toolDefinitions().map((tool) => tool.name),
    [
      "agent_team_codex_watch_mailbox",
      "agent_team_codex_read_mailbox",
      "agent_team_codex_ack",
      "agent_team_codex_reply",
      "agent_team_codex_open_task"
    ]
  );
});

test("Codex MCP channel reads wake payloads and replies through durable mailbox", () => {
  const cwd = tempRoot();
  const message = appendMessage(cwd, {
    from: "claude",
    to: "codex",
    kind: "checkin",
    subject: "Claude update",
    body: "test 123 from Claude",
    task_id: "T-000001",
    goal_id: "G-000001"
  }).message;

  const queued = attemptCodexPush(cwd, "R-daemon", message, false, {});
  assert.equal(queued.result_state, "queued_no_adapter");

  const watched = watchMailbox(cwd, { include_payload: true });
  assert.equal(watched.ok, true);
  assert.equal(watched.wake_rows.length, 1);
  assert.equal(watched.wake_rows[0].message_id, message.id);
  assert.equal(watched.wake_rows[0].payload.message.id, message.id);
  assert.match(watched.wake_rows[0].payload.body_preview, /test 123/);
  assert.equal(watched.messages.length, 1);
  assert.equal(watched.messages[0].id, message.id);

  const read = parseToolResponse(callTool(cwd, "agent_team_codex_read_mailbox", { message_id: message.id }));
  assert.equal(read.message.body, "test 123 from Claude");

  const acked = parseToolResponse(callTool(cwd, "agent_team_codex_ack", { message_id: message.id, note: "Seen now." }));
  assert.equal(acked.ok, true);
  assert.equal(acked.ack.by, "codex");
  assert.equal(acked.receipt.result_state, "seen");

  const reply = parseToolResponse(
    callTool(cwd, "agent_team_codex_reply", {
      in_reply_to: message.id,
      body: "ACK from Codex via MCP."
    })
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.message.from, "codex");
  assert.equal(reply.message.to, "claude");
  assert.equal(reply.message.in_reply_to, message.id);

  const replies = listMessages(cwd, { from: "codex", to: "claude", kind: "reply" });
  assert.equal(replies.length, 1);
  assert.equal(loadMessage(cwd, replies[0].id, { include_body: true }).body, "ACK from Codex via MCP.");
});

test("Codex MCP stdio server initializes, lists tools, and reads wake mailbox", () => {
  const cwd = tempRoot();
  const server = path.join(__dirname, "..", "src", "mcp", "codexServer.js");
  const message = appendMessage(cwd, {
    from: "claude",
    to: "codex",
    kind: "notify",
    subject: "Server wake",
    body: "hello Codex MCP"
  }).message;
  attemptCodexPush(cwd, "R-daemon", message, false, {});

  const result = spawnSync(process.execPath, [server, "--cwd", cwd], {
    input: Buffer.concat([
      encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      encodeFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      encodeFrame({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "agent_team_codex_watch_mailbox",
          arguments: { include_payload: true }
        }
      })
    ]),
    encoding: "buffer"
  });
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  const decoded = decodeFrames(result.stdout);
  assert.equal(decoded.messages[0].result.protocolVersion, "2024-11-05");
  assert.ok(decoded.messages[1].result.tools.find((tool) => tool.name === "agent_team_codex_watch_mailbox"));
  const body = JSON.parse(decoded.messages[2].result.content[0].text);
  assert.equal(body.wake_rows[0].message_id, message.id);
  assert.match(body.wake_rows[0].payload.body_preview, /hello Codex MCP/);
});
