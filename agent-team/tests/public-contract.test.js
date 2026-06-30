const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");

test("public skill keeps Claude work mailbox-first and nonblocking", () => {
  const skill = fs.readFileSync(
    path.join(root, "plugins", "agent-team-harness", "skills", "agent-team-harness", "SKILL.md"),
    "utf8"
  );

  assert.match(skill, /Hard transport rule/);
  assert.match(skill, /do not use raw `ask_claude`/);
  assert.match(skill, /Real work for Claude must be represented in harness state and delivered through mailbox-backed CLI flows/);
  assert.match(skill, /The daemon exists to connect Codex and Claude through the durable mailbox/);
  assert.match(skill, /Codex wake payloads/);
  assert.match(skill, /AGENT_TEAM_CODEX_WAKE_COMMAND/);
  assert.match(skill, /agent-team-codex-wake/);
  assert.match(skill, /agent-team-codex-mcp/);
  assert.match(skill, /agent_team_codex_watch_mailbox/);
  assert.match(skill, /per-message timeline/);
  assert.match(skill, /remembered endpoint id/);
  assert.match(skill, /Display names are labels\/fallbacks, not primary identity/);
  assert.match(skill, /fresh_launch_probe/);
  assert.match(skill, /Claude startup:/);
  assert.match(skill, /Failed Claude startup blocks `start` by default/);
  assert.match(skill, /--allow-degraded-claude/);
});

test("README explains daemon-backed mailbox delegation", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

  assert.match(readme, /The receiver daemon is the bridge/);
  assert.match(readme, /Do not delegate real Claude work through raw `ask_claude`/);
  assert.match(readme, /queues first-party Claude MCP channel notifications/);
  assert.match(readme, /agent-team channel mcp install/);
  assert.match(readme, /agent-team-codex-mcp/);
  assert.match(readme, /agent-team-codex-wake/);
  assert.match(readme, /agent-team codex mcp install/);
  assert.match(readme, /MCP-emitted counts/);
  assert.match(readme, /Codex MCP adapter status/);
  assert.match(readme, /per-message timeline/);
  assert.match(readme, /codex_mcp_seen/);
  assert.match(readme, /legacy Claude channel wake as a compatibility fallback/);
  assert.match(readme, /queues Codex wake payloads/);
  assert.match(readme, /AGENT_TEAM_CODEX_WAKE_COMMAND/);
  assert.match(readme, /cockpit` and `agent-team watch` show Claude MCP outbox totals/);
  assert.match(readme, /CODEX_THREAD_ID/);
  assert.match(readme, /short wake-up copy; the mailbox reply remains the completion truth/);
  assert.match(readme, /remembered endpoint id/);
  assert.match(readme, /Display names are human labels and fallback selectors, not the primary continuity proof/);
  assert.match(readme, /fresh_launch_probe/);
  assert.match(readme, /Claude startup:/);
  assert.match(readme, /failed Claude startup as a blocking setup error by default/);
  assert.match(readme, /--allow-degraded-claude/);
});
