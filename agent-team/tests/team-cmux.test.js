const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createTransport, buildShellCommand } = require("../src/team/cmux");
const { shellQuote } = require("../src/bridge/claudeChannel/utils");

const W = "11111111-aaaa-4111-8111-111111111111";
const S = "22222222-bbbb-4222-8222-222222222222";
const OTHER = "33333333-cccc-4333-8333-333333333333";
const P = "44444444-dddd-4444-8444-444444444444";
const Q = "55555555-eeee-4555-8555-555555555555";
const NEW = "66666666-ffff-4666-8666-666666666666";
const target = { workspace_id: W, surface_id: S };
const allocated = { workspace_id: W, surface_id: NEW, pane_id: P };
const inventory = (surfaces = [{ id: S, type: "terminal" }]) => ({ workspace_id: W, surfaces });
const projectInventory = () => inventory([{ id: S, type: "terminal", pane_id: P }]);
const ok = (payload) => ({ status: 0, stdout: JSON.stringify(payload), stderr: "" });

function mock(...steps) {
  const calls = [];
  const transport = createTransport({
    cmux_bin: "/fake/cmux",
    run(binary, args, options) {
      assert.equal(binary, "/fake/cmux");
      assert.deepEqual(args.slice(0, 4), ["--json", "--id-format", "uuids", "rpc"]);
      assert.equal(args.length, 6);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 15000);
      assert.equal(options.encoding, "utf8");
      assert.ok(options.maxBuffer > 0);
      for (const key of ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_TAB_ID", "CMUX_WINDOW_ID"]) {
        assert.equal(Object.hasOwn(options.env, key), false);
      }
      assert.equal(options.env.CMUX_SOCKET_PATH, process.env.CMUX_SOCKET_PATH);
      assert.equal(options.env.CMUX_SOCKET_PASSWORD, process.env.CMUX_SOCKET_PASSWORD);
      const call = { method: args[4], params: JSON.parse(args[5]) };
      calls.push(call);
      assert.ok(steps.length, `Unexpected RPC ${call.method}`);
      const step = steps.shift();
      assert.equal(call.method, step.method);
      return typeof step.result === "function" ? step.result(call) : step.result;
    }
  });
  return { transport, calls, done: () => assert.equal(steps.length, 0) };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-transport-' "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function preflightFailure(action) {
  assert.throws(action, (error) => {
    assert.equal(error.launch_uncertain, undefined);
    assert.equal(error.session, undefined);
    return true;
  });
}

function uncertainLaunch(action, surface_id, pane_id) {
  assert.throws(action, (error) => {
    assert.equal(error.launch_uncertain, true);
    const expected = { workspace_id: W };
    if (surface_id) expected.surface_id = surface_id;
    // Recover the actual allocated pane, even when it differs from the request.
    if (pane_id) expected.pane_id = pane_id;
    assert.deepEqual(error.session, expected);
    return true;
  });
}

test("creates an eagerly loaded owned workspace with UUIDs, without claiming agent readiness", (t) => {
  const cwd = fixture(t);
  const { transport, calls, done } = mock({ method: "workspace.create", result: ok({
    workspace_id: W.toUpperCase(), surface_id: S.toUpperCase(), workspace_ref: "workspace:2", surface_ref: "surface:3"
  }) });
  const command = { argv: ["fake-native-agent", "--model", "explicit-model", "prompt with \\n and 'quotes'"], env: { JOB_ID: "job-1" } };
  const result = transport.createSession({ cwd, title: "Worker 'one'", command });
  assert.deepEqual(result, { ...target, status: "launching", ready: false });
  assert.deepEqual(calls[0].params, {
    cwd: fs.realpathSync.native(cwd), title: "Worker 'one'", focus: false, eager_load_terminal: true,
    initial_command: buildShellCommand({ cwd: fs.realpathSync.native(cwd), ...command })
  });
  done();
});

test("creation uses the canonical directory for both cmux and its child command", (t) => {
  const cwd = fixture(t);
  const link = path.join(cwd, "alias");
  const actual = path.join(cwd, "actual");
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, link);
  const { transport, calls } = mock({ method: "workspace.create", result: ok(target) });
  transport.createSession({ cwd: link, title: "test", command: { argv: ["fake"] } });
  const canonical = fs.realpathSync.native(actual);
  assert.equal(calls[0].params.cwd, canonical);
  assert.equal(calls[0].params.initial_command, buildShellCommand({ cwd: canonical, argv: ["fake"] }));
});

test("shell launch round-trips argv, env and cwd without evaluating their contents", (t) => {
  const cwd = fixture(t);
  const values = ["", "a'b", 'a"b', "$(printf INJECTED)", "`printf INJECTED`", "semi;colon", "line\nbreak", "literal\\n", "--workspace", "$HOME", "emoji: 🐢"];
  const environment = "' ; $(printf INJECTED) `printf INJECTED`\nnext\\n";
  const argv = [process.execPath, "-e", "process.stdout.write(JSON.stringify({args:process.argv.slice(1),env:process.env.TRANSPORT_TEST_VALUE,cwd:process.cwd()}))", "--", ...values];
  const result = spawnSync("/bin/sh", ["-c", buildShellCommand({ cwd, argv, env: { TRANSPORT_TEST_VALUE: environment } })], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: values, env: environment, cwd: fs.realpathSync.native(cwd) });
});

test("surface commands execute through Ghostty's exec -l while workspace commands retain shell-text dispatch", (t) => {
  const cwd = fixture(t);
  const receipt = path.join(cwd, "started.json");
  const runner = path.join(cwd, "runner with 'quotes'.js");
  fs.writeFileSync(runner, `require("node:fs").writeFileSync(process.env.TRANSPORT_TEST_RECEIPT,
    JSON.stringify({ args: process.argv.slice(2), env: process.env.TRANSPORT_TEST_VALUE, cwd: process.cwd() }));`);
  const values = ["", "a'b", 'a"b', "$(printf INJECTED)", "`printf INJECTED`", "semi;colon", "line\nbreak", "literal\\n", "$HOME"];
  const environment = "' ; $(printf INJECTED) `printf INJECTED`\nnext\\n";
  const command = { argv: [process.execPath, runner, ...values], env: {
    TRANSPORT_TEST_VALUE: environment, TRANSPORT_TEST_RECEIPT: receipt
  } };
  const { transport, calls, done } = mock(
    { method: "workspace.create", result: ok(target) },
    { method: "surface.list", result: ok(projectInventory()) },
    { method: "surface.create", result: ok(allocated) },
    { method: "tab.action", result: ok(allocated) }
  );
  transport.createSession({ cwd, title: "legacy", command });
  transport.createSession({ workspace_id: W, anchor_surface_id: S, cwd, title: "grouped", command });
  const workspaceCommand = calls[0].params.initial_command;
  const surfaceCommand = calls[2].params.initial_command;
  assert.match(workspaceCommand, /^exec \/bin\/sh -c /);
  assert.match(surfaceCommand, /^\/bin\/sh -c /);
  const ghostty = (text) => spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `exec -l ${text}`], { encoding: "utf8" });
  // The live failure: a shell builtin cannot occupy Ghostty's executable slot.
  const broken = ghostty(workspaceCommand);
  assert.equal(broken.status, 127);
  assert.match(broken.stderr, /exec: exec:.*not found/);
  assert.equal(fs.existsSync(receipt), false);
  // workspace.create adds this shell boundary server-side; suppress personal
  // profiles in the fixture while exercising the same command-text boundary.
  const wrappedWorkspace = `/bin/bash --noprofile --norc -lc ${shellQuote(workspaceCommand)}`;
  for (const executableCommand of [surfaceCommand, wrappedWorkspace]) {
    const result = ghostty(executableCommand);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, "utf8")), {
      args: values, env: environment, cwd: fs.realpathSync.native(cwd)
    });
    fs.unlinkSync(receipt);
  }
  done();
});

test("invalid launch input fails before cmux allocation", (t) => {
  const cwd = fixture(t);
  const { transport, calls } = mock();
  const valid = { cwd, title: "test", command: { argv: ["fake"] } };
  for (const change of [
    { cwd: "relative" }, { cwd: path.join(cwd, "missing") }, { title: "" }, { command: "raw shell" },
    { command: { argv: [] } }, { command: { argv: ["-option"] } }, { command: { argv: ["fake", null] } },
    { command: { argv: ["fake\0"] } }, { command: { argv: ["fake"], env: [] } },
    { command: { argv: ["fake"], env: { "BAD;KEY": "value" } } },
    { command: { argv: ["fake"], env: { CMUX_SURFACE_ID: OTHER } } },
    { command: { argv: ["fake"], env: { KEY: "bad\0" } } },
    { command: { argv: ["fake"], env: { KEY: 123 } } }
  ]) {
    preflightFailure(() => transport.createSession({ ...valid, ...change }));
    preflightFailure(() => transport.createSession({ ...valid, workspace_id: W, ...change }));
  }
  assert.equal(calls.length, 0);
});

test("all existing-session operations require two UUIDs, never refs or current defaults", () => {
  const { transport, calls } = mock();
  for (const method of ["readSession", "sendText", "closeSession", "closeProject"]) {
    for (const invalid of [undefined, null, "", "current", "workspace:1", "surface:2", "0", "--all", ` ${W}`]) {
      assert.throws(() => transport[method]({ ...target, workspace_id: invalid, text: "test" }), /UUID/);
      assert.throws(() => transport[method]({ ...target, surface_id: invalid, text: "test" }), /UUID/);
    }
  }
  assert.equal(calls.length, 0);
});

test("mismatched workspace/surface pairs cannot read, send or close", () => {
  for (const method of ["readSession", "sendText", "closeSession", "closeProject"]) {
    const { transport, calls, done } = mock({ method: "surface.list", result: ok(inventory([{ id: OTHER, type: "terminal" }])) });
    assert.throws(() => transport[method]({ ...target, text: "must not send", submit: true }), /does not belong/);
    assert.deepEqual(calls, [{ method: "surface.list", params: { workspace_id: W } }]);
    done();
  }
});

test("malformed, ambiguous, nonterminal or wrongly routed inventories fail closed", () => {
  for (const payload of [
    { workspace_id: OTHER, surfaces: [{ id: S, type: "terminal" }] },
    { surfaces: [{ id: S, type: "terminal" }] }, { workspace_id: W }, inventory([]),
    inventory([{ id: "surface:3", type: "terminal" }]), inventory([{ id: S, type: "browser" }]),
    inventory([{ id: S, type: "terminal" }, { id: S, type: "terminal" }]),
    inventory([{ id: S, type: "terminal" }, { id: OTHER, type: "browser" }, { id: OTHER.toUpperCase(), type: "terminal" }]),
    inventory([{ id: S, type: "terminal" }, { id: "surface:9", type: "browser" }])
  ]) {
    for (const method of ["readSession", "sendText", "closeSession", "closeProject"]) {
      const { transport, calls, done } = mock({ method: "surface.list", result: ok(payload) });
      assert.throws(() => transport[method]({ ...target, text: "test" }));
      assert.deepEqual(calls, [{ method: "surface.list", params: { workspace_id: W } }]);
      done();
    }
  }
});

test("reads only the addressed surface and preserves text exactly", () => {
  for (const text of ["", " leading\ntrailing \n"]) {
    const { transport, calls, done } = mock(
      { method: "surface.list", result: ok(inventory()) },
      { method: "surface.read_text", result: ok({ ...target, text }) }
    );
    assert.deepEqual(transport.readSession(target), { ...target, text });
    assert.deepEqual(calls[1].params, target);
    done();
  }
});

test("read result rejects wrong addresses and absent text", () => {
  for (const payload of [{ ...target, surface_id: OTHER, text: "wrong" }, { ...target }]) {
    const { transport } = mock(
      { method: "surface.list", result: ok(inventory()) },
      { method: "surface.read_text", result: ok(payload) }
    );
    assert.throws(() => transport.readSession(target));
  }
});

test("sends literal text as JSON and submits only when explicitly requested", () => {
  const text = '--workspace other; $(bad) `bad` "quoted" \\n\nnext';
  for (const submit of [undefined, false, true]) {
    const steps = [
      { method: "surface.list", result: ok(inventory()) },
      { method: "surface.send_text", result: ok(target) }
    ];
    if (submit) steps.push({ method: "surface.send_key", result: ok(target) });
    const { transport, calls, done } = mock(...steps);
    assert.deepEqual(transport.sendText({ ...target, text, submit }), { ...target, submitted: submit === true });
    assert.deepEqual(calls[1].params, { ...target, text });
    if (submit) assert.deepEqual(calls[2].params, { ...target, key: "enter" });
    done();
  }
});

test("empty text permits an explicit enter without a blank send", () => {
  const { transport, done } = mock(
    { method: "surface.list", result: ok(inventory()) },
    { method: "surface.send_key", result: ok(target) }
  );
  assert.deepEqual(transport.sendText({ ...target, text: "", submit: true }), { ...target, submitted: true });
  done();
});

test("failed or wrongly routed text delivery never sends enter or retries", () => {
  for (const result of [
    { status: 1, stdout: "", stderr: "Access denied: only processes started inside cmux can connect" },
    ok({ ...target, surface_id: OTHER })
  ]) {
    const { transport, calls, done } = mock(
      { method: "surface.list", result: ok(inventory()) },
      { method: "surface.send_text", result }
    );
    assert.throws(() => transport.sendText({ ...target, text: "test", submit: true }));
    assert.equal(calls.length, 2);
    done();
  }
});

test("invalid text or submit types fail before touching cmux", () => {
  const { transport, calls } = mock();
  assert.throws(() => transport.sendText({ ...target, text: "bad\0" }));
  assert.throws(() => transport.sendText({ ...target, text: "valid", submit: "false" }));
  assert.equal(calls.length, 0);
});

test("closeSession verifies inventory and closes only the addressed surface", () => {
  const { transport, calls, done } = mock(
    { method: "surface.list", result: ok(inventory([
      { id: OTHER, type: "browser", focused: true }, { id: S, type: "terminal", focused: false }
    ])) },
    { method: "surface.close", result: ok(target) }
  );
  const closed = transport.closeSession(target);
  assert.deepEqual(closed, { ...target, status: "closed" });
  assert.equal(Object.hasOwn(closed, "process_stopped"), false);
  assert.deepEqual(calls, [
    { method: "surface.list", params: { workspace_id: W } },
    { method: "surface.close", params: target }
  ]);
  done();
});

test("closeSession refuses the last surface and never falls back to workspace.close", () => {
  const { transport, calls, done } = mock({ method: "surface.list", result: ok(inventory()) });
  assert.throws(() => transport.closeSession(target), /last surface/i);
  assert.deepEqual(calls, [{ method: "surface.list", params: { workspace_id: W } }]);
  done();
});

test("cmux failures are visible and never trigger fallback binaries or global setup", () => {
  for (const result of [
    { status: null, error: { code: "ENOENT" }, stdout: "", stderr: "" },
    { status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" },
    { status: null, signal: "SIGTERM", stdout: "", stderr: "" },
    { status: 1, stdout: "", stderr: "Access denied: only processes started inside cmux can connect" },
    { status: 0, stdout: "OK workspace:2", stderr: "" }, ok(null), ok([]), ok({ ok: false }), ok({ error: "failed" })
  ]) {
    const { transport, calls, done } = mock({ method: "surface.list", result });
    assert.throws(() => transport.readSession(target));
    assert.equal(calls.length, 1);
    done();
  }
});

test("failed create reports uncertain launch and any recovered address without auto cleanup", (t) => {
  const cwd = fixture(t);
  for (const result of [
    { status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" },
    ok({ workspace_ref: "workspace:2", surface_ref: "surface:3" }),
    ok({ workspace_id: W, surface_id: null })
  ]) {
    const { transport, calls, done } = mock({ method: "workspace.create", result });
    assert.throws(() => transport.createSession({ cwd, title: "test", command: { argv: ["fake"] } }), (error) => {
      assert.equal(error.launch_uncertain, true);
      if (result.stdout.includes(W)) assert.deepEqual(error.session, { workspace_id: W });
      else assert.equal(error.session, undefined);
      return true;
    });
    assert.equal(calls.length, 1);
    done();
  }
});

test("runner exceptions omit launch arguments from the top-level error", (t) => {
  const cwd = fixture(t);
  const transport = createTransport({ cmux_bin: "/fake/cmux", run() { throw new Error("fake runner stopped"); } });
  assert.throws(() => transport.createSession({ cwd, title: "test", command: { argv: ["fake", "PRIVATE_PROMPT"] } }), (error) => {
    assert.equal(error.launch_uncertain, true);
    assert.equal(error.message.includes("PRIVATE_PROMPT"), false);
    assert.match(error.message, /command runner failed/);
    return true;
  });
});

test("createProject canonicalizes cwd and allocates only a neutral workspace", (t) => {
  const cwd = fixture(t);
  const alias = path.join(cwd, "alias");
  fs.symlinkSync(cwd, alias);
  const title = "Project 'one' ; $(literal)";
  for (const pane_id of [undefined, P.toUpperCase()]) {
    const { transport, calls, done } = mock({ method: "workspace.create", result: ok({
      workspace_id: W.toUpperCase(), surface_id: S.toUpperCase(), pane_id
    }) });
    assert.deepEqual(transport.createProject({ cwd: alias, title }), {
      ...target, ...(pane_id ? { pane_id: P } : {})
    });
    assert.deepEqual(calls, [{ method: "workspace.create", params: {
      cwd: fs.realpathSync.native(cwd), title, focus: false, eager_load_terminal: true
    } }]);
    done();
  }
});

test("createProject rejects invalid titles and non-directory paths before allocation", (t) => {
  const cwd = fixture(t);
  const { transport, calls } = mock();
  for (const change of [
    { cwd: undefined }, { cwd: "relative" }, { cwd: path.join(cwd, "missing") }, { cwd: __filename },
    { cwd: `${cwd}\0` }, { title: undefined }, { title: "" }, { title: "bad\0" }
  ]) preflightFailure(() => transport.createProject({ cwd, title: "project", ...change }));
  assert.deepEqual(calls, []);
});

test("createProject rejects malformed allocation addresses without retry or cleanup", (t) => {
  const cwd = fixture(t);
  for (const payload of [
    { workspace_id: "workspace:1", surface_id: S }, { workspace_id: W },
    { ...target, surface_id: "surface:1" }, { ...target, pane_id: "pane:1" }
  ]) {
    const { transport, calls, done } = mock({ method: "workspace.create", result: ok(payload) });
    assert.throws(() => transport.createProject({ cwd, title: "project" }), (error) => {
      assert.equal(error.launch_uncertain, true);
      return true;
    });
    assert.deepEqual(calls.map((call) => call.method), ["workspace.create"]);
    done();
  }
});

test("grouped launches select the addressed pane despite focus, order and uppercase IDs", (t) => {
  const cwd = fixture(t);
  const alias = path.join(cwd, "alias");
  fs.symlinkSync(cwd, alias);
  const canonical = fs.realpathSync.native(cwd);
  const title = "Job 'one' ; $(literal)";
  const command = { argv: ["fake-agent", "'quoted'", "literal\\n", "line\nbreak"], env: { JOB: "$(literal)" } };
  const surfaces = [
    { id: OTHER.toUpperCase(), type: "terminal", pane_id: Q, focused: true },
    { id: S.toUpperCase(), type: "terminal", pane_id: P.toUpperCase(), focused: false }
  ];
  for (const rows of [surfaces, [...surfaces].reverse()]) {
    for (const selector of [
      { anchor_surface_id: S.toUpperCase() }, { pane_id: P.toUpperCase() },
      { anchor_surface_id: S.toUpperCase(), pane_id: P.toUpperCase() }
    ]) {
      const { transport, calls, done } = mock(
        { method: "surface.list", result: ok({ workspace_id: W.toUpperCase(), surfaces: rows }) },
        { method: "surface.create", result: ok({
          workspace_id: W.toUpperCase(), surface_id: NEW.toUpperCase(), pane_id: P.toUpperCase(), type: "terminal"
        }) },
        { method: "tab.action", result: ok({ workspace_id: W.toUpperCase(), surface_id: NEW.toUpperCase() }) }
      );
      assert.deepEqual(transport.createSession({ workspace_id: W.toUpperCase(), ...selector, cwd: alias, title, command }), {
        ...allocated, status: "launching", ready: false
      });
      assert.deepEqual(calls, [
        { method: "surface.list", params: { workspace_id: W } },
        { method: "surface.create", params: {
          workspace_id: W, pane_id: P, type: "terminal", working_directory: canonical,
          initial_command: buildShellCommand({ cwd: canonical, ...command, exec_prefix: false }), focus: false
        } },
        { method: "tab.action", params: { workspace_id: W, surface_id: NEW, action: "rename", title, focus: false } }
      ]);
      done();
    }
  }
});

test("grouped launch without selectors requires one unique non-dock pane", (t) => {
  const cwd = fixture(t);
  const surfaces = [
    { id: S, type: "terminal", pane_id: P.toUpperCase(), focused: false },
    { id: OTHER, type: "browser", pane_id: P, focused: true },
    { id: Q, type: "terminal", pane_id: "pane:dock", dock_scope: "window", focused: true }
  ];
  for (const rows of [surfaces, [...surfaces].reverse()]) {
    const { transport, calls, done } = mock(
      { method: "surface.list", result: ok(inventory(rows)) },
      { method: "surface.create", result: ok(allocated) },
      { method: "tab.action", result: ok(allocated) }
    );
    assert.deepEqual(transport.createSession({ workspace_id: W, cwd, title: "job", command: { argv: ["fake"] } }), {
      ...allocated, status: "launching", ready: false
    });
    assert.equal(calls[1].params.pane_id, P);
    assert.deepEqual(calls.map((call) => call.method), ["surface.list", "surface.create", "tab.action"]);
    done();
  }
});

test("grouped launch validates every explicit UUID before the first RPC", (t) => {
  const cwd = fixture(t);
  const { transport, calls } = mock();
  const valid = { workspace_id: W, anchor_surface_id: S, pane_id: P, cwd, title: "job", command: { argv: ["fake"] } };
  for (const key of ["workspace_id", "anchor_surface_id", "pane_id"]) {
    for (const invalid of [null, "", "current", "workspace:1", "surface:2", "pane:3", "0", "--all", ` ${W}`, `${W}\0`, 123, {}]) {
      assert.throws(() => transport.createSession({ ...valid, [key]: invalid }), (error) => {
        assert.match(error.message, /UUID/);
        assert.equal(error.launch_uncertain, undefined);
        return true;
      });
    }
  }
  assert.deepEqual(calls, []);
});

test("grouped inventory and selector failures stop before allocation without uncertainty", (t) => {
  const cwd = fixture(t);
  const anchor = { id: S, type: "terminal", pane_id: P };
  const other = { id: OTHER, type: "terminal", pane_id: Q, focused: true };
  const dock = { id: OTHER, type: "terminal", pane_id: Q, dock_scope: "window" };
  const cases = [
    { payload: { workspace_id: OTHER, surfaces: [anchor] } },
    { payload: { surfaces: [anchor] } },
    { payload: { workspace_id: "workspace:1", surfaces: [anchor] } },
    { payload: { workspace_id: W } },
    { payload: inventory([]) },
    { payload: inventory([other]) },
    { payload: inventory([{ ...anchor, type: "browser" }]) },
    { payload: inventory([{ ...anchor, pane_id: undefined }]) },
    { payload: inventory([{ ...anchor, pane_id: "pane:1" }]) },
    { payload: inventory([anchor, { ...other, id: "surface:2" }]) },
    { payload: inventory([anchor, { ...anchor, id: S.toUpperCase() }]) },
    { payload: inventory([anchor, other, { ...other, id: OTHER.toUpperCase() }]) },
    { payload: inventory([anchor, dock]), selector: { anchor_surface_id: OTHER } },
    { payload: inventory([anchor, dock]), selector: { pane_id: Q } },
    { payload: inventory([anchor, other]), selector: { anchor_surface_id: S, pane_id: Q } },
    { payload: inventory([anchor]), selector: { pane_id: Q } },
    { payload: inventory([anchor, other]), selector: {} },
    { payload: inventory([other, anchor]), selector: {} },
    { payload: inventory([dock]), selector: {} },
    { payload: inventory([anchor, { ...other, pane_id: "pane:2" }]), selector: {} }
  ];
  for (const { payload, selector = { anchor_surface_id: S } } of cases) {
    const { transport, calls, done } = mock({ method: "surface.list", result: ok(payload) });
    preflightFailure(() => transport.createSession({ workspace_id: W, ...selector, cwd, title: "job", command: { argv: ["fake"] } }));
    assert.deepEqual(calls, [{ method: "surface.list", params: { workspace_id: W } }]);
    done();
  }
});

test("failed grouped inventory RPC is a preflight failure", (t) => {
  const cwd = fixture(t);
  const { transport, calls, done } = mock({ method: "surface.list", result: {
    status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: ""
  } });
  preflightFailure(() => transport.createSession({ workspace_id: W, cwd, title: "job", command: { argv: ["fake"] } }));
  assert.deepEqual(calls.map((call) => call.method), ["surface.list"]);
  done();
});

test("grouped allocation rejects bad addresses, aliases, panes and nonterminal responses", (t) => {
  const cwd = fixture(t);
  const cases = [
    { payload: { ...allocated, workspace_id: OTHER } },
    { payload: { ...allocated, workspace_id: undefined } },
    { payload: { ...allocated, workspace_id: "workspace:1" } },
    { payload: { ...allocated, surface_id: undefined } },
    { payload: { ...allocated, surface_id: "surface:2" } },
    { payload: { ...allocated, surface_id: S.toUpperCase() } },
    { payload: { ...allocated, surface_id: OTHER.toUpperCase() } },
    { payload: { ...allocated, pane_id: undefined }, recoveredSurface: NEW },
    { payload: { ...allocated, pane_id: "pane:3" }, recoveredSurface: NEW },
    { payload: { ...allocated, pane_id: Q.toUpperCase() }, recoveredSurface: NEW, recoveredPane: Q },
    { payload: { ...allocated, type: "browser" }, recoveredSurface: NEW, recoveredPane: P },
    { payload: { ...allocated, type: null }, recoveredSurface: NEW, recoveredPane: P }
  ];
  for (const { payload, recoveredSurface, recoveredPane } of cases) {
    const { transport, calls, done } = mock(
      { method: "surface.list", result: ok(inventory([
        { id: S.toUpperCase(), type: "terminal", pane_id: P },
        { id: OTHER, type: "terminal", pane_id: Q, dock_scope: "window" }
      ])) },
      { method: "surface.create", result: ok(payload) }
    );
    uncertainLaunch(() => transport.createSession({ workspace_id: W, anchor_surface_id: S, cwd, title: "job", command: { argv: ["fake"] } }), recoveredSurface, recoveredPane);
    assert.deepEqual(calls.map((call) => call.method), ["surface.list", "surface.create"]);
    done();
  }
});

test("failed grouped allocation retains the expected workspace without retry or cleanup", (t) => {
  const cwd = fixture(t);
  for (const result of [
    { status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" },
    { status: 1, stdout: "", stderr: "allocation failed" },
    { status: 0, stdout: "not JSON", stderr: "" }, ok(null), ok({ ok: false })
  ]) {
    const { transport, calls, done } = mock(
      { method: "surface.list", result: ok(projectInventory()) },
      { method: "surface.create", result }
    );
    uncertainLaunch(() => transport.createSession({ workspace_id: W, cwd, title: "job", command: { argv: ["fake"] } }));
    assert.deepEqual(calls.map((call) => call.method), ["surface.list", "surface.create"]);
    done();
  }
});

test("rename failure retains the allocated session and never retries or cleans up", (t) => {
  const cwd = fixture(t);
  for (const result of [
    { status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" },
    { status: 1, stdout: "", stderr: "rename failed" },
    ok({ ...allocated, workspace_id: OTHER }), ok({ ...allocated, surface_id: S }),
    ok({ workspace_id: W }), ok({ surface_id: NEW }),
    ok({ ...allocated, workspace_id: "workspace:1" }), ok({ ...allocated, surface_id: "surface:1" })
  ]) {
    const { transport, calls, done } = mock(
      { method: "surface.list", result: ok(projectInventory()) },
      { method: "surface.create", result: ok(allocated) },
      { method: "tab.action", result }
    );
    uncertainLaunch(() => transport.createSession({ workspace_id: W, cwd, title: "job", command: { argv: ["fake"] } }), NEW, P);
    assert.deepEqual(calls.map((call) => call.method), ["surface.list", "surface.create", "tab.action"]);
    done();
  }
});

test("closeSession rejects malformed or failed close responses without workspace fallback", () => {
  for (const result of [
    ok({ ...target, workspace_id: OTHER }), ok({ ...target, surface_id: OTHER }),
    ok({ workspace_id: W }), ok({ ...target, surface_id: "surface:1" }),
    { status: 1, stdout: "", stderr: "cannot close last surface" }
  ]) {
    const { transport, calls, done } = mock(
      { method: "surface.list", result: ok(inventory([{ id: S, type: "terminal" }, { id: OTHER, type: "terminal" }])) },
      { method: "surface.close", result }
    );
    assert.throws(() => transport.closeSession(target));
    assert.deepEqual(calls, [
      { method: "surface.list", params: { workspace_id: W } }, { method: "surface.close", params: target }
    ]);
    done();
  }
});

test("closeProject verifies the sole addressed terminal and closes exactly its workspace", () => {
  const { transport, calls, done } = mock(
    { method: "surface.list", result: ok({ workspace_id: W.toUpperCase(), surfaces: [{ id: S.toUpperCase(), type: "terminal" }] }) },
    { method: "workspace.close", result: ok({ workspace_id: W.toUpperCase() }) }
  );
  assert.deepEqual(transport.closeProject({ workspace_id: W.toUpperCase(), surface_id: S.toUpperCase() }), { ...target, status: "closed" });
  assert.deepEqual(calls, [
    { method: "surface.list", params: { workspace_id: W } },
    { method: "workspace.close", params: { workspace_id: W } }
  ]);
  done();
});

test("closeProject refuses every additional surface, including docks and reordered rows", () => {
  for (const other of [
    { id: OTHER, type: "terminal" }, { id: OTHER, type: "browser" },
    { id: OTHER, type: "terminal", dock_scope: "window" }
  ]) {
    const rows = [{ id: S, type: "terminal" }, other];
    for (const surfaces of [rows, [...rows].reverse()]) {
      const { transport, calls, done } = mock({ method: "surface.list", result: ok(inventory(surfaces)) });
      assert.throws(() => transport.closeProject(target), /other surfaces/i);
      assert.deepEqual(calls, [{ method: "surface.list", params: { workspace_id: W } }]);
      done();
    }
  }
});

test("closeProject rejects wrong or missing workspace confirmation without retry", () => {
  for (const payload of [{ workspace_id: OTHER }, { workspace_id: "workspace:1" }, {}]) {
    const { transport, calls, done } = mock(
      { method: "surface.list", result: ok(inventory()) },
      { method: "workspace.close", result: ok(payload) }
    );
    assert.throws(() => transport.closeProject(target));
    assert.deepEqual(calls.map((call) => call.method), ["surface.list", "workspace.close"]);
    done();
  }
});

test("read and send keep exact addressing after inventory normalization and reordering", () => {
  const rows = [
    { id: OTHER.toUpperCase(), type: "terminal", focused: true },
    { id: S.toUpperCase(), type: "terminal", focused: false }
  ];
  for (const surfaces of [rows, [...rows].reverse()]) {
    for (const method of ["readSession", "sendText"]) {
      const rpcMethod = method === "readSession" ? "surface.read_text" : "surface.send_text";
      const { transport, calls, done } = mock(
        { method: "surface.list", result: ok({ workspace_id: W.toUpperCase(), surfaces }) },
        { method: rpcMethod, result: ok({ workspace_id: W.toUpperCase(), surface_id: S.toUpperCase(), text: "literal\\n" }) }
      );
      const result = transport[method]({ workspace_id: W.toUpperCase(), surface_id: S.toUpperCase(), text: "literal\\n" });
      assert.deepEqual(result, { ...target, ...(method === "readSession" ? { text: "literal\\n" } : { submitted: false }) });
      assert.deepEqual(calls[1], { method: rpcMethod, params: { ...target, ...(method === "sendText" ? { text: "literal\\n" } : {}) } });
      done();
    }
  }
});

test("one project owns two job tabs and closing one preserves the controller and other job", (t) => {
  const cwd = fixture(t);
  const canonical = fs.realpathSync.native(cwd);
  let surfaces = [];
  const listedOrders = [];
  const list = () => {
    // Return fresh snapshots in alternating order, including after allocation
    // and deletion. List positions never serve as durable session addresses.
    const rows = listedOrders.length % 2 ? [...surfaces].reverse() : [...surfaces];
    listedOrders.push(rows.map((surface) => surface.id));
    return ok(inventory(rows));
  };
  const createTab = (id) => ({ params }) => {
    surfaces.push({ id, type: "terminal", pane_id: params.pane_id });
    return ok({ workspace_id: params.workspace_id, surface_id: id, pane_id: params.pane_id });
  };
  const { transport, calls, done } = mock(
    { method: "workspace.create", result() {
      surfaces.push({ id: S, type: "terminal", pane_id: P });
      return ok({ ...target, pane_id: P });
    } },
    { method: "surface.list", result: list },
    { method: "surface.create", result: createTab(NEW) },
    { method: "tab.action", result: ok({ workspace_id: W, surface_id: NEW }) },
    { method: "surface.list", result: list },
    { method: "surface.create", result: createTab(OTHER) },
    { method: "tab.action", result: ok({ workspace_id: W, surface_id: OTHER }) },
    { method: "surface.list", result: list },
    { method: "surface.close", result({ params }) {
      surfaces = surfaces.filter((surface) => surface.id !== params.surface_id);
      return ok(params);
    } },
    { method: "surface.list", result: list },
    { method: "surface.read_text", result: ok({ ...target, text: "controller alive" }) },
    { method: "surface.list", result: list },
    { method: "surface.read_text", result: ok({ workspace_id: W, surface_id: OTHER, text: "other job alive" }) }
  );
  const project = transport.createProject({ cwd, title: "project" });
  assert.deepEqual(project, { ...target, pane_id: P });
  const launch = (title) => transport.createSession({
    workspace_id: project.workspace_id, anchor_surface_id: project.surface_id,
    cwd, title, command: { argv: ["fake-agent", title] }
  });
  const first = launch("first job");
  const second = launch("second job");
  assert.deepEqual(first, { ...allocated, status: "launching", ready: false });
  assert.deepEqual(second, { workspace_id: W, surface_id: OTHER, pane_id: P, status: "launching", ready: false });
  assert.deepEqual(transport.closeSession(first), { workspace_id: W, surface_id: NEW, status: "closed" });
  assert.deepEqual(transport.readSession(project), { ...target, text: "controller alive" });
  assert.deepEqual(transport.readSession(second), { workspace_id: W, surface_id: OTHER, text: "other job alive" });
  assert.deepEqual(surfaces, [
    { id: S, type: "terminal", pane_id: P }, { id: OTHER, type: "terminal", pane_id: P }
  ]);
  assert.deepEqual(listedOrders, [[S], [NEW, S], [S, NEW, OTHER], [OTHER, S], [S, OTHER]]);
  const create = (title) => ({ method: "surface.create", params: {
    workspace_id: W, pane_id: P, type: "terminal", working_directory: canonical,
    initial_command: buildShellCommand({ cwd: canonical, argv: ["fake-agent", title], exec_prefix: false }), focus: false
  } });
  const rename = (surface_id, title) => ({ method: "tab.action", params: {
    workspace_id: W, surface_id, action: "rename", title, focus: false
  } });
  const listing = { method: "surface.list", params: { workspace_id: W } };
  assert.deepEqual(calls, [
    { method: "workspace.create", params: { cwd: canonical, title: "project", focus: false, eager_load_terminal: true } },
    listing, create("first job"), rename(NEW, "first job"),
    listing, create("second job"), rename(OTHER, "second job"),
    listing, { method: "surface.close", params: { workspace_id: W, surface_id: NEW } },
    listing, { method: "surface.read_text", params: target },
    listing, { method: "surface.read_text", params: { workspace_id: W, surface_id: OTHER } }
  ]);
  done();
});
