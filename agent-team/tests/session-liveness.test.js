const test = require("node:test");
const assert = require("node:assert");
const { tempRoot } = require("./helpers");
const { recordMcpStarted } = require("../src/bridge/claudeChannel/boot");
const { sessionProcessAlive } = require("../src/bridge/claudeChannel");

test("LIVE-1 session is alive when its recorded MCP pid is running", () => {
  const cwd = tempRoot();
  recordMcpStarted(cwd, { launch_id: "L-alive", pid: process.pid });
  assert.equal(sessionProcessAlive(cwd, { launch_id: "L-alive" }), true);
});

test("LIVE-2 session is dead when its recorded MCP pid is gone", () => {
  const cwd = tempRoot();
  // A pid far above any real max — process.kill will throw ESRCH.
  recordMcpStarted(cwd, { launch_id: "L-dead", pid: 2147483646 });
  assert.equal(sessionProcessAlive(cwd, { launch_id: "L-dead" }), false);
});

test("LIVE-3 no launch_id or no proof row => not reusable", () => {
  const cwd = tempRoot();
  assert.equal(sessionProcessAlive(cwd, {}), false);
  assert.equal(sessionProcessAlive(cwd, { launch_id: "L-none" }), false);
});
