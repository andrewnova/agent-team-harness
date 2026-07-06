// Keep these in-process tests hermetic: never let a fall-through launch open a window.
process.env.AGENT_TEAM_HEADLESS = "1";

const test = require("node:test");
const assert = require("node:assert");
const { tempRoot } = require("./helpers");
const { recordMcpStarted } = require("../src/bridge/claudeChannel/boot");
const { persistEnsure } = require("../src/bridge/claudeChannel/session");
const { create } = require("../src/bridge/claudeChannel");

function seedSession(cwd, { launchId, pid }) {
  recordMcpStarted(cwd, { launch_id: launchId, pid });
  persistEnsure(cwd, {
    ok: true,
    name: "myproj",
    target: "myproj",
    project_dir: cwd,
    launch_id: launchId,
    launch_mode: "visible",
    delivery_ready: true
  });
}

test("ADOPT-1 a live recorded session is adopted by default (no fresh launch)", () => {
  const cwd = tempRoot();
  seedSession(cwd, { launchId: "L-live", pid: process.pid });
  const result = create("claude-channel").ensure(cwd, { name: "myproj", project_dir: cwd });
  assert.equal(result.ok, true);
  assert.equal(result.action, "reused_recorded_first_party_session");
  assert.equal(result.launch_id, "L-live");
});

test("ADOPT-2 --fresh-claude bypasses adoption even when a live session exists", () => {
  const cwd = tempRoot();
  seedSession(cwd, { launchId: "L-live", pid: process.pid });
  const result = create("claude-channel").ensure(cwd, { name: "myproj", project_dir: cwd, fresh_claude: true });
  assert.notEqual(result.action, "reused_recorded_first_party_session");
});

test("ADOPT-3 a dead recorded session is not adopted (falls through to launch)", () => {
  const cwd = tempRoot();
  seedSession(cwd, { launchId: "L-dead", pid: 2147483646 });
  const result = create("claude-channel").ensure(cwd, { name: "myproj", project_dir: cwd });
  assert.notEqual(result.action, "reused_recorded_first_party_session");
});

test("XPROJ-1 a live session from another project is not adopted (project-scoped)", () => {
  const cwd = tempRoot();
  const otherProject = tempRoot();
  // A live session recorded for a DIFFERENT project, same name.
  recordMcpStarted(cwd, { launch_id: "L-other", pid: process.pid });
  persistEnsure(cwd, {
    ok: true,
    name: "myproj",
    target: "myproj",
    project_dir: otherProject,
    launch_id: "L-other",
    delivery_ready: true
  });
  // ensure() for THIS project must not adopt the other project's session.
  const result = create("claude-channel").ensure(cwd, { name: "myproj", project_dir: cwd });
  assert.notEqual(result.action, "reused_recorded_first_party_session");
});

test("NAME-1 a live session is not adopted for a different requested name", () => {
  const cwd = tempRoot();
  seedSession(cwd, { launchId: "L-live", pid: process.pid });
  // A different workstream name in the same project must not adopt the "myproj" session.
  const result = create("claude-channel").ensure(cwd, { name: "otherproj", project_dir: cwd });
  assert.notEqual(result.action, "reused_recorded_first_party_session");
});

test("MULTI-1 a later recovery session does not hijack the primary's slot", () => {
  const cwd = tempRoot();
  // Primary live session.
  seedSession(cwd, { launchId: "L-primary", pid: process.pid });
  // A recovery launch with a DIFFERENT name is recorded afterwards — under single-slot
  // session.json this clobbers the primary and makes it un-adoptable.
  persistEnsure(cwd, {
    ok: true,
    name: "agent-team-recover-x",
    target: "agent-team-recover-x",
    project_dir: cwd,
    launch_id: "L-recover"
  });
  // ensure() for the PRIMARY name must still adopt the primary via the history.
  const result = create("claude-channel").ensure(cwd, { name: "myproj", project_dir: cwd });
  assert.equal(result.action, "reused_recorded_first_party_session");
  assert.equal(result.launch_id, "L-primary");
});
