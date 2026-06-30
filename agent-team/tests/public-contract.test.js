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
});

test("README explains daemon-backed mailbox delegation", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

  assert.match(readme, /The receiver daemon is the bridge/);
  assert.match(readme, /Do not delegate real Claude work through raw `ask_claude`/);
  assert.match(readme, /immediately wakes the visible Claude channel/);
  assert.match(readme, /queues Codex wake payloads/);
  assert.match(readme, /AGENT_TEAM_CODEX_WAKE_COMMAND/);
  assert.match(readme, /cockpit` and `agent-team watch` show Codex wake totals/);
  assert.match(readme, /CODEX_THREAD_ID/);
  assert.match(readme, /short wake-up copy; the mailbox reply remains the completion truth/);
});
