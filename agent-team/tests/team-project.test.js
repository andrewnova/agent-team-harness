const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tempRoot } = require("./helpers");
const { ensureProject, attachProject, getProject } = require("../src/team/project");

const address = { workspace_id: "11111111-1111-4111-8111-111111111111", surface_id: "22222222-2222-4222-8222-222222222222" };
const fixture = (t) => { const root = fs.realpathSync(tempRoot()); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

test("one coordinator creates one sidebar project across subsequent launches", (t) => {
  const root = fixture(t);
  const createProject = t.mock.fn(() => address);
  const project = ensureProject(root, { title: "Harness", transport: { createProject } });
  assert.deepEqual(project, { ...address, title: "Harness" });
  assert.deepEqual(ensureProject(root, { transport: { createProject } }), project);
  assert.equal(createProject.mock.callCount(), 1);
});

test("uncertain project creation cannot allocate a duplicate project on retry", (t) => {
  const root = fixture(t);
  const createProject = t.mock.fn(() => { throw new Error("allocation response lost"); });
  assert.throws(() => ensureProject(root, { transport: { createProject } }), /response lost/);
  assert.throws(() => ensureProject(root, { transport: { createProject } }), /pending or uncertain/);
  assert.equal(createProject.mock.callCount(), 1);
  assert.ok(fs.existsSync(path.join(root, ".agent-team", "state", "cmux-project.json.lock", "error.json")));
});

test("attaching a known project verifies its anchor and refuses reassignment", (t) => {
  const root = fixture(t);
  const readSession = t.mock.fn((input) => ({ ...input, text: "controller" }));
  assert.equal(getProject(root), null);
  assert.deepEqual(attachProject(root, { ...address, title: "Harness" }, { readSession }), { ...address, title: "Harness" });
  assert.deepEqual(readSession.mock.calls[0].arguments[0], address);
  assert.throws(() => attachProject(root, { ...address, workspace_id: "33333333-3333-4333-8333-333333333333" }, { readSession }), /another cmux project/);
  assert.equal(getProject(root).workspace_id, address.workspace_id);
});
