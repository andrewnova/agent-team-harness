const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createTransport, buildShellCommand } = require("../src/team/cmux");

const W = "11111111-aaaa-4111-8111-111111111111";
const S = "22222222-bbbb-4222-8222-222222222222";
const OTHER = "33333333-cccc-4333-8333-333333333333";
const target = { workspace_id: W, surface_id: S };
const inventory = (surfaces = [{ id: S, type: "terminal" }]) => ({ workspace_id: W, surfaces });
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
      return step.result;
    }
  });
  return { transport, calls, done: () => assert.equal(steps.length, 0) };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-transport-' "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
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
  ]) assert.throws(() => transport.createSession({ ...valid, ...change }));
  assert.equal(calls.length, 0);
});

test("all existing-session operations require two UUIDs, never refs or current defaults", () => {
  const { transport, calls } = mock();
  for (const method of ["readSession", "sendText", "closeSession"]) {
    for (const invalid of [undefined, null, "", "current", "workspace:1", "surface:2", "0", "--all", ` ${W}`]) {
      assert.throws(() => transport[method]({ ...target, workspace_id: invalid, text: "test" }), /UUID/);
      assert.throws(() => transport[method]({ ...target, surface_id: invalid, text: "test" }), /UUID/);
    }
  }
  assert.equal(calls.length, 0);
});

test("mismatched workspace/surface pairs cannot read, send or close", () => {
  for (const method of ["readSession", "sendText", "closeSession"]) {
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
    inventory([{ id: S, type: "terminal" }, { id: S, type: "terminal" }])
  ]) {
    const { transport, calls } = mock({ method: "surface.list", result: ok(payload) });
    assert.throws(() => transport.sendText({ ...target, text: "test" }));
    assert.equal(calls.length, 1);
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

test("close verifies the sole owned terminal and closes only its workspace", () => {
  const { transport, calls, done } = mock(
    { method: "surface.list", result: ok(inventory()) },
    { method: "workspace.close", result: ok({ workspace_id: W }) }
  );
  const closed = transport.closeSession(target);
  assert.deepEqual(closed, { ...target, status: "closed" });
  assert.equal(Object.hasOwn(closed, "process_stopped"), false);
  assert.deepEqual(calls[1], { method: "workspace.close", params: { workspace_id: W } });
  done();
});

test("close refuses additional surfaces without closing any pane", () => {
  const { transport, calls, done } = mock({ method: "surface.list", result: ok(inventory([
    { id: S, type: "terminal" }, { id: OTHER, type: "browser" }
  ])) });
  assert.throws(() => transport.closeSession(target), /other surfaces/);
  assert.equal(calls.length, 1);
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
