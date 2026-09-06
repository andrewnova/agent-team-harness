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
  assert.deepEqual(ensureProject(root, { transport: { createProject, readSession: (input) => input } }), project);
  assert.equal(createProject.mock.callCount(), 1);
});

test("uncertain project creation cannot allocate a duplicate project on retry", (t) => {
  const root = fixture(t);
  const createProject = t.mock.fn(() => { throw Object.assign(new Error("allocation response lost"), { launch_uncertain: true }); });
  assert.throws(() => ensureProject(root, { transport: { createProject } }), /response lost/);
  assert.throws(() => ensureProject(root, { transport: { createProject } }), /pending or uncertain/);
  assert.equal(createProject.mock.callCount(), 1);
  assert.ok(fs.existsSync(path.join(root, ".agent-team", "state", "cmux-project.json.lock", "error.json")));
});

test("missing owned controller is replaced once inside the same workspace", (t) => {
  const root = fixture(t);
  const replacement = { ...address, surface_id: "33333333-3333-4333-8333-333333333333" };
  const createProject = t.mock.fn(() => address);
  const createSession = t.mock.fn(() => replacement);
  const transport = { createProject, createSession, readSession(input) {
    if (input.surface_id === address.surface_id) throw Object.assign(new Error("controller missing"), { code: "CMUX_SURFACE_NOT_FOUND" });
    return input;
  } };
  ensureProject(root, { title: "Harness", transport });
  assert.deepEqual(ensureProject(root, { transport }), { ...replacement, title: "Harness" });
  assert.deepEqual(ensureProject(root, { transport }), getProject(root));
  assert.equal(createProject.mock.callCount(), 1);
  assert.equal(createSession.mock.callCount(), 1);
  assert.deepEqual(createSession.mock.calls[0].arguments[0], {
    workspace_id: address.workspace_id, cwd: root, title: "Harness · controller", command: { argv: ["/bin/sh"] }
  });
});

test("unavailable cmux or an ambiguous pane never allocates a replacement or poisons a safe retry", (t) => {
  const root = fixture(t);
  ensureProject(root, { transport: { createProject: () => address } });
  const createSession = t.mock.fn(() => { throw new Error("ambiguous pane"); });
  const transport = { createSession, readSession() { throw new Error("socket unavailable"); } };
  assert.throws(() => ensureProject(root, { transport }), /socket unavailable/);
  assert.equal(createSession.mock.callCount(), 0);
  transport.readSession = () => { throw Object.assign(new Error("missing"), { code: "CMUX_SURFACE_NOT_FOUND" }); };
  assert.throws(() => ensureProject(root, { transport }), /ambiguous pane/);
  transport.readSession = (input) => input;
  assert.deepEqual(ensureProject(root, { transport }), getProject(root));
  assert.equal(fs.existsSync(path.join(root, ".agent-team", "state", "cmux-project.json.lock")), false);
});

test("known allocation survives a lost rename response and is adopted on retry without reallocating", (t) => {
  const root = fixture(t);
  const replacement = { ...address, surface_id: "33333333-3333-4333-8333-333333333333" };
  ensureProject(root, { transport: { createProject: () => address } });
  const createSession = t.mock.fn(() => { throw Object.assign(new Error("rename response lost"), { launch_uncertain: true, session: replacement }); });
  const transport = { createSession, readSession(input) {
    if (input.surface_id === address.surface_id) throw Object.assign(new Error("missing"), { code: "CMUX_SURFACE_NOT_FOUND" });
    return input;
  } };
  assert.throws(() => ensureProject(root, { transport }), /rename response lost/);
  assert.equal(ensureProject(root, { transport }).surface_id, replacement.surface_id);
  assert.equal(ensureProject(root, { transport }).surface_id, replacement.surface_id);
  assert.equal(createSession.mock.callCount(), 1);
  assert.equal(fs.existsSync(path.join(root, ".agent-team", "state", "cmux-project.json.lock")), false);
});

test("known initial allocation is verified before adoption and unknown repair outcomes remain reserved", (t) => {
  const root = fixture(t);
  const createProject = t.mock.fn(() => { throw Object.assign(new Error("allocation uncertain"), { launch_uncertain: true, session: address }); });
  const createSession = t.mock.fn(() => { throw Object.assign(new Error("repair uncertain"), { launch_uncertain: true, session: { workspace_id: address.workspace_id } }); });
  const transport = { createProject, createSession, readSession() { throw new Error("cmux unavailable"); } };
  assert.throws(() => ensureProject(root, { transport, title: "Harness" }), /allocation uncertain/);
  assert.throws(() => ensureProject(root, { transport }), /cmux unavailable/);
  assert.equal(getProject(root), null);
  transport.readSession = (input) => input;
  assert.deepEqual(ensureProject(root, { transport }), { ...address, title: "Harness" });
  transport.readSession = () => { throw Object.assign(new Error("missing"), { code: "CMUX_SURFACE_NOT_FOUND" }); };
  assert.throws(() => ensureProject(root, { transport }), /repair uncertain/);
  assert.throws(() => ensureProject(root, { transport }), /pending or uncertain/);
  assert.equal(createProject.mock.callCount(), 1);
  assert.equal(createSession.mock.callCount(), 1);
  assert.equal(getProject(root).surface_id, address.surface_id);
});

test("project recovery refuses aliased reservations and preserves the target evidence", (t) => {
  const root = fixture(t);
  const external = fixture(t);
  getProject(root);
  const evidence = path.join(external, "error.json");
  fs.writeFileSync(evidence, JSON.stringify({ session: address }));
  const lock = path.join(root, ".agent-team", "state", "cmux-project.json.lock");
  fs.symlinkSync(external, lock);
  const readSession = t.mock.fn((input) => input);
  assert.throws(() => ensureProject(root, { transport: { readSession } }), /must not be aliased/);
  assert.equal(readSession.mock.callCount(), 0);
  assert.ok(fs.existsSync(evidence));
  assert.equal(getProject(root), null);
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
