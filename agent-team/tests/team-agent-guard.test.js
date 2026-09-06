const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempRoot } = require("./helpers");
const { check } = require("../src/team/claudeAgentGuard");

const PARENT_SESSION = "11111111-1111-4111-8111-111111111111";
const CHILD_SESSION = "22222222-2222-4222-8222-222222222222";
const PARENT = { session_id: PARENT_SESSION };
const CHILDREN = [
  ["agent_id in the parent session", { ...PARENT, agent_id: "native-child" }],
  ["a different session without agent_id", { session_id: CHILD_SESSION }]
];
const TEAM_TOOLS = ["team_inbox", "team_send", "team_reply", "team_report"];
const WRITE_CALLS = [
  ["Write", { file_path: "/assigned/src/example.js", content: "changed source" }],
  ["Edit", { file_path: "/assigned/src/example.js", old_string: "before", new_string: "after" }],
  ["MultiEdit", { file_path: "/assigned/src/example.js", edits: [] }],
  ["NotebookEdit", { notebook_path: "/assigned/source.ipynb", new_source: "changed source" }],
  ["Bash", { command: "printf changed > src/example.js" }]
];

function toolInput(identity, tool_name, tool_input = {}) {
  return { hook_event_name: "PreToolUse", ...identity, tool_name, tool_input };
}

function decision(input, writable = false) {
  return check(input, { session_id: PARENT_SESSION, writable });
}

function assertDenied(output, reason, message) {
  assert.equal(output.hookSpecificOutput?.hookEventName, "PreToolUse", message);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny", message);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, reason, message);
}

function fixture(t) {
  const temporary = fs.realpathSync(tempRoot());
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, "native session with spaces");
  fs.mkdirSync(directory);
  const run = (input, mode = "read", args = [directory, PARENT_SESSION, mode]) => {
    const result = spawnSync(process.execPath, [require.resolve("../src/team/claudeAgentGuard"), ...args], {
      cwd: temporary,
      input: typeof input === "string" ? input : JSON.stringify(input),
      encoding: "utf8",
      timeout: 10000
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  return { directory, run };
}

test("read-only parent retains all four harness team tools without overriding native permissions", () => {
  for (const tool of TEAM_TOOLS) {
    assert.deepEqual(decision(toolInput(PARENT, `mcp__agent_team__${tool}`)), {}, tool);
  }
  for (const tool of ["mcp__agent_team__team_report_extra", "mcp__other__team_report"]) {
    assertDenied(decision(toolInput(PARENT, tool)), /read-only/i, tool);
  }
});

for (const [label, identity] of CHILDREN) {
  test(`child identified by ${label} cannot inherit the parent's harness mailbox in either permission mode`, () => {
    for (const writable of [false, true]) {
      for (const tool of TEAM_TOOLS) {
        // Tool arguments claiming parent identity cannot replace the hook's caller identity.
        const input = toolInput(identity, `mcp__agent_team__${tool}`, { session_id: PARENT_SESSION, job_id: "parent-job" });
        assertDenied(decision(input, writable), /parent.*job|parent.*identity|mailbox/i, `${tool}, writable=${writable}`);
      }
    }
  });

  test(`read-only child identified by ${label} retains native agents, messaging, reading and task coordination`, () => {
    for (const tool of ["Agent", "SendMessage", "Read", "Glob", "Grep", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskOutput", "TaskStop"]) {
      assert.deepEqual(decision(toolInput(identity, tool)), {}, tool);
    }
  });

  test(`writer child identified by ${label} leaves ordinary writes and Bash to native permissions`, () => {
    for (const [tool, input] of WRITE_CALLS) {
      assert.deepEqual(decision(toolInput(identity, tool, input), true), {}, tool);
    }
  });
}

for (const [label, identity] of [["parent", PARENT], ...CHILDREN]) {
  test(`read-only ${label} denies source writes and Bash despite inherited writer permissions`, () => {
    for (const [tool, input] of WRITE_CALLS) {
      const event = {
        ...toolInput(identity, tool, input),
        permission_mode: "acceptEdits",
        agent_type: "writer-with-edit-tools"
      };
      assertDenied(decision(event), /read-only/i, tool);
    }
    assertDenied(decision(toolInput(identity, "Bash", { command: "git status --short" })), /read-only/i, "even a read command uses forbidden Bash");
  });
}

test("hook executable emits valid allow/defer and deny JSON for parent and child calls", (t) => {
  const f = fixture(t);
  for (const [identity, mode, denied] of [[PARENT, "read", false], [CHILDREN[0][1], "read", true], [CHILDREN[1][1], "write", true]]) {
    const result = f.run(toolInput(identity, "mcp__agent_team__team_report"), mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    if (denied) assertDenied(output, /parent.*job|parent.*identity|mailbox/i);
    else assert.deepEqual(output, {});
  }
  assert.deepEqual(fs.readdirSync(f.directory), [], "tool decisions must not create lifecycle evidence");
});

test("hook executable rejects malformed JSON and invalid invocation arguments with exit code 2", (t) => {
  const f = fixture(t);
  const cases = [
    ["empty stdin", ""],
    ["invalid JSON", "not-json"],
    ["truncated JSON", '{"hook_event_name":"PreToolUse"'],
    ["null payload", "null"],
    ["missing arguments", {}, []],
    ["empty parent session", {}, [f.directory, "", "read"]],
    ["invalid permission mode", {}, [f.directory, PARENT_SESSION, "acceptEdits"]],
    ["extra argument", {}, [f.directory, PARENT_SESSION, "read", "extra"]]
  ];
  for (const [label, input, args] of cases) {
    const result = f.run(input, "read", args);
    assert.equal(result.status, 2, label);
    assert.equal(result.stdout, "", label);
    assert.ok(result.stderr.trim(), `${label} must explain the failure`);
  }
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test("hook executable rejects structurally invalid JSON payloads with exit code 2", (t) => {
  const f = fixture(t);
  const malformed = [
    {},
    [],
    42,
    { hook_event_name: "PreToolUse", session_id: PARENT_SESSION }
  ];
  const outcomes = [];
  for (const mode of ["read", "write"]) {
    for (const input of malformed) {
      const result = f.run(input, mode);
      outcomes.push({ mode, input, status: result.status });
    }
  }
  assert.deepEqual(outcomes, outcomes.map((outcome) => ({ ...outcome, status: 2 })), "invalid hook payloads must not silently defer to native permissions");
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

for (const mode of ["read", "write"]) {
  test(`${mode} child lifecycle records metadata only and supplies inherited permission and parent identity guidance`, (t) => {
    const f = fixture(t);
    const secrets = {
      prompt: "PRIVATE-PROMPT-CONTENT",
      transcript: "PRIVATE-TRANSCRIPT-CONTENT",
      transcript_path: "/private/PRIVATE-PARENT-TRANSCRIPT.jsonl",
      agent_transcript_path: "/private/PRIVATE-CHILD-TRANSCRIPT.jsonl",
      last_assistant_message: "PRIVATE-CHILD-RESULT",
      tool_input: { prompt: "PRIVATE-NESTED-PROMPT" }
    };
    const metadata = { agent_id: "native-child", agent_type: "general-purpose", session_id: PARENT_SESSION, effort: "medium" };
    const before = Date.now();
    const outputs = [];
    for (const event of ["SubagentStart", "SubagentStop"]) {
      const result = f.run({ hook_event_name: event, ...metadata, ...secrets }, mode);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      outputs.push(result.stdout);
      if (event === "SubagentStart") {
        const output = JSON.parse(result.stdout).hookSpecificOutput;
        assert.equal(output.hookEventName, "SubagentStart");
        assert.match(output.additionalContext, /assigned model and effort/i);
        assert.match(output.additionalContext, /return findings to your native parent/i);
        assert.match(output.additionalContext, /do not use the parent's agent_team MCP identity/i);
        if (mode === "read") {
          assert.match(output.additionalContext, /read-only/i);
          assert.match(output.additionalContext, /do not change files or run commands/i);
        } else {
          assert.match(output.additionalContext, /private worktrees.*simultaneous writers/i);
          assert.match(output.additionalContext, /preserve other agents' edits/i);
          assert.match(output.additionalContext, /assigned scope/i);
        }
      } else assert.equal(result.stdout, "", "stopping a child should only record evidence");
    }
    const after = Date.now();
    const evidence = path.join(f.directory, "native-agents.jsonl");
    const raw = fs.readFileSync(evidence, "utf8");
    assert.ok(raw.endsWith("\n"));
    const records = raw.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 2, "stop must append without overwriting start");
    for (const [index, event] of ["SubagentStart", "SubagentStop"].entries()) {
      const { at, ...record } = records[index];
      assert.deepEqual(record, { event, ...metadata }, "only approved metadata belongs in lifecycle evidence");
      assert.equal(new Date(at).toISOString(), at);
      assert.ok(Date.parse(at) >= before && Date.parse(at) <= after);
    }
    for (const secret of [secrets.prompt, secrets.transcript, secrets.transcript_path, secrets.agent_transcript_path, secrets.last_assistant_message, secrets.tool_input.prompt]) {
      assert.equal(`${raw}${outputs.join("")}`.includes(secret), false, "lifecycle artifacts and guidance must omit private input");
    }
    assert.equal(fs.statSync(evidence).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(f.directory), ["native-agents.jsonl"]);
  });
}
