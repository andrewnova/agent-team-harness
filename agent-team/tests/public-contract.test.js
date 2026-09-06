const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");

test("legacy skill reference keeps daemon work mailbox-first and nonblocking", () => {
  const skill = fs.readFileSync(
    path.join(root, "plugins", "agent-team-harness", "skills", "agent-team-harness", "references", "legacy-daemon.md"),
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
  assert.match(skill, /legacy Claude channel CLI is not the normal wake path/);
  assert.match(skill, /--recover-visible/);
  assert.match(skill, /--legacy-live-push/);
  assert.match(skill, /per-message timeline/);
  assert.match(skill, /remembered endpoint id/);
  assert.match(skill, /Display names are labels\/fallbacks, not primary identity/);
  assert.match(skill, /per-launch Claude MCP config/);
  assert.match(skill, /launch-scoped server name/);
  assert.match(skill, /--mcp-config/);
  assert.match(skill, /fresh_launch_probe/);
  assert.match(skill, /endpoint_selection/);
  assert.match(skill, /startup_proof/);
  assert.match(skill, /duplicate-proof/);
  assert.match(skill, /Claude startup:/);
  assert.match(skill, /mcp_start/);
  assert.match(skill, /mcp_init/);
  assert.match(skill, /--use-development-channel/);
  assert.match(skill, /channel startup-packet --launch-id/);
  assert.match(skill, /channel startup-import --launch-id/);
  assert.match(skill, /does not bypass mailbox, review, merge, proof, or done gates/);
  assert.match(skill, /Failed Claude startup blocks `start` by default/);
  assert.match(skill, /--allow-degraded-claude/);
});

test("README links to a runnable native starter and preserves legacy documentation", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const entry = readme.match(/node (scripts\/[a-z-]+\.js) --project/);
  assert.ok(entry, "quickstart must identify the shipped starter");
  const result = require("node:child_process").spawnSync(process.execPath, [path.join(root, entry[1]), "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const option of ["--project", "--leader", "--max-active"]) assert.ok(result.stdout.includes(option));
  for (const name of ["cmux-team.md", "legacy-workflow.md"]) {
    assert.ok(readme.includes(`docs/${name}`));
    assert.ok(fs.existsSync(path.join(root, "docs", name)));
  }
});
