const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { tempRoot, backendTaskInput, frontendTaskInput, frontendContract, writeExecutable } = require("./helpers");
const { processAlive } = require("../src/daemon");

const cli = path.join(__dirname, "..", "src", "cli.js");

function run(cwd, args, env = process.env) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function initGitRepo(cwd) {
  git(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "pilot\n");
  git(cwd, ["add", "README.md"]);
  git(cwd, ["-c", "user.name=Agent Team", "-c", "user.email=agent-team@example.test", "commit", "-m", "init"]);
}

test("CLI smoke: daemon liveness treats EPERM probes as alive", () => {
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === 424242 && signal === 0) {
      const error = new Error("operation not permitted");
      error.code = "EPERM";
      throw error;
    }
    return originalKill(pid, signal);
  };
  try {
    assert.equal(processAlive(424242), true);
  } finally {
    process.kill = originalKill;
  }
});

test("CLI smoke: init, goal, plan claude via mock, task create, board", () => {
  const cwd = tempRoot();
  const start = JSON.parse(run(cwd, ["start", "--no-ensure-claude"]).stdout);
  assert.equal(start.operator, "codex");
  assert.equal(start.execution_profile, "turbo_parallel");
  assert.equal(start.acceleration.codex_native_subagents.max_concurrent, 6);
  assert.equal(start.acceleration.claude_agent_teams.enabled, true);
  assert.equal(start.claude_channel_startup.skipped, true);
  assert.equal(start.claude_channel, null);
  assert.equal(start.question, "Do you want Planning Mode or Dev Mode?");
  assert.equal(start.modes.length, 2);
  run(cwd, ["init"]);
  const config = JSON.parse(run(cwd, ["config"]).stdout);
  assert.equal(config.execution_profile, "turbo_parallel");
  assert.equal(config.parallelism_policy.default, "parallel_first_after_task_split");
  const goal = JSON.parse(run(cwd, ["goal", "new", "--title", "Harness", "--objective", "Build it"]).stdout);
  assert.equal(goal.goal_id, "G-000001");
  const updatedGoal = JSON.parse(
    run(cwd, ["goal", "update", goal.goal_id, "--title", "Harness v2", "--objective", "Build it with corrections"]).stdout
  );
  assert.equal(updatedGoal.title, "Harness v2");
  assert.equal(updatedGoal.objective, "Build it with corrections");
  assert.equal(updatedGoal.acceptance_intent, "Build it with corrections");
  run(cwd, ["plan", "codex", "--goal", goal.goal_id, "--text", "Codex says backend/proof first."]);
  run(cwd, ["plan", "claude", "--goal", goal.goal_id, "--adapter", "mock", "--prompt", "Review plan"]);
  run(cwd, ["plan", "import-claude", "--goal", goal.goal_id]);
  run(cwd, ["plan", "reconcile", "--goal", goal.goal_id, "--text", "Reconciled: Claude frontend, Codex backend and proof."]);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(frontendTaskInput({ goal_id: goal.goal_id }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  assert.equal(task.owner, "claude");
  assert.equal(task.acceleration_policy.claude_agent_teams, "max_useful_frontend_parallelism");
  const status = JSON.parse(run(cwd, ["channel", "status"]).stdout);
  assert.equal(typeof status.ok, "boolean");
  const cockpit = JSON.parse(run(cwd, ["watch", "--once", "--json", "--no-live-channel"]).stdout);
  assert.equal(cockpit.operator, "codex");
  assert.equal(cockpit.mode, "dev");
  assert.equal(cockpit.tasks.total, 1);
  assert.equal(cockpit.claude_channel.runtime.checked, false);
  assert.match(cockpit.next_actions.join("\n"), /Claim T-000001 as claude/);
  const regroundRequest = JSON.parse(run(cwd, ["reground", "request", task.task_id, "--adapter", "mock"]).stdout);
  const regroundImport = JSON.parse(run(cwd, ["reground", "import", task.task_id, "--request-id", regroundRequest.request_id]).stdout);
  assert.equal(regroundImport.ok, true);
  assert.equal(regroundImport.packet.restated_objective, task.objective);
  run(cwd, ["board"]);
  assert.match(fs.readFileSync(path.join(cwd, ".agent-team", "projections", "board.md"), "utf8"), /Frontend task/);
  assert.match(fs.readFileSync(path.join(cwd, ".agent-team", "projections", "plans", "G-000001.md"), "utf8"), /Reconciled plan: true/);
  const completedGoal = JSON.parse(run(cwd, ["goal", "update", goal.goal_id, "--status", "complete"]).stdout);
  assert.equal(completedGoal.status, "complete");
  assert.equal(completedGoal.post_goal_self_heal_offer.requires_user_confirmation, true);
  assert.match(completedGoal.post_goal_self_heal_offer.recommended_command, /self-heal recommend/);
});

test("CLI smoke: cockpit renders a concise Codex operating view", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const output = run(cwd, ["cockpit", "--no-live-channel"]).stdout;
  assert.match(output, /Codex Agent Team Cockpit/);
  assert.match(output, /Mode: choose-mode/);
  assert.match(output, /Create a goal/);
});

test("CLI smoke: Claude steering notices scan into cockpit and can be acknowledged", () => {
  const cwd = tempRoot();
  const projectDir = path.join(cwd, "project");
  const planningDir = path.join(projectDir, "docs", "planning");
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(
    path.join(planningDir, "claude-notice-ui.md"),
    [
      "# NOTICE for Codex - UI ownership correction",
      "",
      "From: Claude",
      "",
      "Re: T-000001 / G-000001",
      "",
      "Codex should stop modifying frontend files and hand the UI task back to Claude."
    ].join("\n")
  );
  run(cwd, ["init"]);
  const scan = JSON.parse(run(cwd, ["notice", "scan", "--project-dir", projectDir]).stdout);
  assert.equal(scan.imported.length, 1);
  assert.equal(scan.pending.length, 1);
  const noticeId = scan.imported[0].notice_id;
  const listed = JSON.parse(run(cwd, ["notice", "list", "--status", "new"]).stdout);
  assert.equal(listed.notices[0].notice_id, noticeId);
  const shown = JSON.parse(run(cwd, ["notice", "show", noticeId]).stdout);
  assert.equal(shown.notice.task_id, "T-000001");
  const cockpit = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(cockpit.claude_steering.pending, 1);
  assert.match(cockpit.next_actions.join("\n"), /Read Claude notice/);
  const applied = JSON.parse(run(cwd, ["notice", "ack", noticeId, "--status", "applied", "--note", "Ownership restored"]).stdout);
  assert.equal(applied.notice.status, "applied");
  const events = JSON.parse(run(cwd, ["events", "--type", "claude_notice.applied"]).stdout).events;
  assert.equal(events.length, 1);
});

test("CLI smoke: post-build refactor loop is offered, confirmed, compared, and taskified", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const goal = JSON.parse(run(cwd, ["goal", "new", "--title", "Refactor Loop", "--objective", "Use Codex and Claude to harden the build"]).stdout);
  const final = JSON.parse(run(cwd, ["verify", "final", "--allow-empty"]).stdout);
  assert.equal(final.ok, true);
  assert.equal(final.post_build_refactor_offer.requires_user_confirmation, true);
  assert.match(final.post_build_refactor_offer.recommended_command, /refactor offer/);
  const offer = JSON.parse(run(cwd, ["refactor", "offer", "--goal", goal.goal_id, "--scope", "repo"]).stdout).offer;
  assert.equal(offer.status, "offered");
  assert.equal(offer.requires_user_confirmation, true);
  assert.match(offer.prompt, /Refactor until you are happy with the architecture/);
  const started = JSON.parse(run(cwd, ["refactor", "start", offer.offer_id]).stdout);
  assert.equal(started.ok, true);
  assert.equal(started.run.kind, "post_build_refactor");
  assert.equal(started.offer.status, "accepted");

  const codexRecommendation = path.join(cwd, "codex-refactor.json");
  fs.writeFileSync(
    codexRecommendation,
    JSON.stringify(
      {
        recommendations: ["Simplify state mutation paths and preserve proof gates."],
        risks: ["Do not let refactor recommendations mutate state automatically."],
        task_candidates: [
          {
            title: "Harden refactor state flow",
            objective: "Keep the refactor workflow advisory until taskified and verified.",
            acceptance_criteria: ["Refactor records are persisted in advisory state", "Normal task gates still apply"],
            allowed_paths: ["agent-team/src/**"],
            forbidden_paths: ["agent-team/node_modules/**"],
            proof: { commands: ["npm test"], requires_browser: false, requires_screenshot: false }
          }
        ]
      },
      null,
      2
    )
  );
  const claudeRecommendation = path.join(cwd, "claude-refactor.json");
  fs.writeFileSync(
    claudeRecommendation,
    JSON.stringify(
      {
        recommendations: ["Claude should own any UI-facing refactor polish."],
        task_candidates: [
          {
            title: "Polish frontend cockpit view",
            objective: "Improve the frontend-visible cockpit information hierarchy.",
            acceptance_criteria: ["Pending steering and refactor offers are visible"],
            allowed_paths: ["agent-team/src/cockpit.js"],
            forbidden_paths: ["agent-team/src/db.js"],
            frontend_contract: frontendContract(),
            proof: { commands: ["npm test"], requires_browser: true, requires_screenshot: true }
          }
        ]
      },
      null,
      2
    )
  );
  const importedCodex = JSON.parse(run(cwd, ["refactor", "import", "--run", started.run.run_id, "--source", "codex", "--json", codexRecommendation]).stdout);
  const importedClaude = JSON.parse(run(cwd, ["refactor", "import", "--run", started.run.run_id, "--source", "claude", "--json", claudeRecommendation]).stdout);
  assert.equal(importedCodex.recommendation.source, "codex");
  assert.equal(importedClaude.recommendation.source, "claude");
  const compared = JSON.parse(run(cwd, ["refactor", "compare", "--run", started.run.run_id]).stdout);
  assert.equal(compared.comparison.decision_owner, "codex");
  assert.equal(compared.recommendations.length, 2);
  const taskified = JSON.parse(run(cwd, ["refactor", "taskify", "--run", started.run.run_id, "--create"]).stdout);
  assert.equal(taskified.created_tasks.length, 2);
  assert.deepEqual(taskified.created_tasks.map((task) => task.owner).sort(), ["claude", "codex"]);
  assert.match(taskified.created_tasks[0].goal_prompt, /Goal: G-000001/);
  assert.ok(taskified.created_tasks.some((task) => /Claude owns this task/.test(task.goal_prompt)));
  const dbRows = JSON.parse(run(cwd, ["db", "query", "--sql", "select kind,count(*) as count from advisory where kind like 'refactor-%' group by kind order by kind"]).stdout);
  assert.deepEqual(dbRows.rows.map((row) => row.kind), ["refactor-comparisons", "refactor-offers", "refactor-recommendations"]);
});

test("CLI smoke: Claude check-ins and self-heal recommendations require Codex/human confirmation", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const goal = JSON.parse(run(cwd, ["goal", "new", "--title", "Feedback Loop", "--objective", "Let the harness learn from feedback safely"]).stdout);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(frontendTaskInput({ goal_id: goal.goal_id }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const checkin = JSON.parse(
    run(cwd, [
      "checkin",
      "record",
      "--from",
      "claude",
      "--goal",
      goal.goal_id,
      "--task",
      task.task_id,
      "--status",
      "active",
      "--summary",
      "Working the UI slice",
      "--steer",
      "Codex should keep backend schema changes out of this frontend task."
    ]).stdout
  );
  assert.equal(checkin.checkin.requires_codex_attention, true);
  const cockpit = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(cockpit.agent_checkins.pending_steering, 1);
  assert.match(cockpit.next_actions.join("\n"), /Read Claude check-in/);
  const acked = JSON.parse(run(cwd, ["checkin", "ack", checkin.checkin.checkin_id, "--status", "acknowledged", "--note", "Keeping schema untouched"]).stdout);
  assert.equal(acked.checkin.ack_status, "acknowledged");

  const feedback = JSON.parse(
    run(cwd, [
      "feedback",
      "record",
      "--source",
      "user",
      "--scope",
      "post-build-refactor",
      "--goal",
      goal.goal_id,
      "--text",
      "After every build, offer a refactor loop but do not self-heal without confirmation."
    ]).stdout
  );
  assert.equal(feedback.feedback.status, "recorded");
  const toolChange = JSON.parse(
    run(cwd, [
      "self-heal",
      "request-change",
      "--from",
      "claude",
      "--surface",
      "skill",
      "--goal",
      goal.goal_id,
      "--title",
      "Read pending self-heal before tool edits",
      "--reason",
      "Claude noticed Codex may improve the harness during use",
      "--request",
      "Before changing the CLI, skill, or plugin, read pending self-heal context and keep the change confirmation-gated."
    ]).stdout
  );
  assert.equal(toolChange.recommendation.type, "tool_change_request");
  assert.equal(toolChange.recommendation.source, "claude");
  assert.equal(toolChange.recommendation.target_surface, "skill");
  assert.equal(toolChange.recommendation.change_request, true);
  assert.equal(toolChange.recommendation.requires_user_confirmation, true);
  assert.equal(toolChange.recommendation.applied, false);
  const context = JSON.parse(run(cwd, ["self-heal", "context", "--goal", goal.goal_id]).stdout);
  assert.equal(context.read_before_harness_changes, true);
  assert.equal(context.pending_tool_change_requests.length, 1);
  assert.equal(context.pending_tool_change_requests[0].recommendation_id, toolChange.recommendation.recommendation_id);
  assert.equal(context.policy.confirmation_required, true);
  const cockpitAfterToolChange = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.match(cockpitAfterToolChange.next_actions.join("\n"), /Review tool change request from claude/);
  const prematureApply = spawnSync(process.execPath, [cli, "self-heal", "mark-applied", toolChange.recommendation.recommendation_id], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(prematureApply.status, 1);
  assert.match(prematureApply.stderr, /must be approved before it can be marked applied/);
  const selfHeal = JSON.parse(
    run(cwd, [
      "self-heal",
      "recommend",
      "--goal",
      goal.goal_id,
      "--title",
      "Keep self-heal confirmation gated",
      "--reason",
      "User wants recommendation first",
      "--recommendation",
      "Persist feedback and propose harness changes, but wait for explicit user approval before applying them."
    ]).stdout
  );
  assert.equal(selfHeal.recommendation.requires_user_confirmation, true);
  assert.equal(selfHeal.recommendation.applied, false);
  const approved = JSON.parse(run(cwd, ["self-heal", "approve", selfHeal.recommendation.recommendation_id, "--note", "Approved recommendation only"]).stdout);
  assert.equal(approved.recommendation.status, "approved");
  assert.equal(approved.recommendation.approved, true);
  assert.equal(approved.recommendation.applied, false);
  const approvedToolChange = JSON.parse(
    run(cwd, ["self-heal", "approve", toolChange.recommendation.recommendation_id, "--note", "Approved as a request, not automatically applied"]).stdout
  );
  assert.equal(approvedToolChange.recommendation.status, "approved");
  assert.equal(approvedToolChange.recommendation.applied, false);
  const appliedToolChange = JSON.parse(
    run(cwd, [
      "self-heal",
      "mark-applied",
      toolChange.recommendation.recommendation_id,
      "--note",
      "Skill now documents where to read and update tool-change requests",
      "--evidence",
      "npm test"
    ]).stdout
  );
  assert.equal(appliedToolChange.recommendation.status, "applied");
  assert.equal(appliedToolChange.recommendation.applied, true);
  assert.equal(appliedToolChange.recommendation.applied_evidence, "npm test");
  const approvals = fs.readFileSync(path.join(cwd, ".agent-team", "state", "policies", "approvals.jsonl"), "utf8");
  assert.match(approvals, /self-heal/);
});

test("CLI smoke: realtime mailbox lets Claude check in anytime and answer nonblocking dispatches", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput({ status: "review" }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);

  const checkin = JSON.parse(
    run(cwd, [
      "mailbox",
      "send",
      "--from",
      "claude",
      "--to",
      "codex",
      "--kind",
      "checkin",
      "--task",
      task.task_id,
      "--subject",
      "Waiting on frontend Agent Teams",
      "--body",
      "Claude is still active and waiting on two frontend subagents."
    ]).stdout
  );
  assert.equal(checkin.ok, true);
  assert.equal(checkin.message.kind, "checkin");

  const watchOnce = JSON.parse(run(cwd, ["mailbox", "watch", "--to", "codex", "--unacked", "--once"]).stdout);
  assert.equal(watchOnce.messages.length, 1);
  assert.equal(watchOnce.messages[0].id, checkin.message.id);
  const cockpit = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(cockpit.mailbox.codex_unread, 1);
  assert.equal(cockpit.mailbox.recent_claude_checkins.length, 1);
  assert.equal(cockpit.mailbox.codex_inbox[0].informational, true);
  assert.equal(cockpit.mailbox.codex_inbox[0].semantic_ack_required, false);
  assert.match(cockpit.next_actions.join("\n"), /Read Codex advisory mailbox/);
  const acked = JSON.parse(run(cwd, ["mailbox", "ack", checkin.message.id, "--by", "codex", "--note", "Saw Claude status"]).stdout);
  assert.equal(acked.ok, true);
  const afterAck = JSON.parse(run(cwd, ["mailbox", "inbox", "--to", "codex", "--unacked"]).stdout);
  assert.equal(afterAck.messages.length, 0);

  const dispatched = JSON.parse(
    run(cwd, [
      "channel",
      "dispatch",
      "--kind",
      "review",
      "--task",
      task.task_id,
      "--prompt",
      "Review the backend task without blocking Codex."
    ]).stdout
  );
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.nonblocking, true);
  assert.equal(dispatched.request.adapter, "mailbox");
  assert.equal(dispatched.request.dispatch_state, "queued");
  const claudeInbox = JSON.parse(run(cwd, ["mailbox", "inbox", "--to", "claude", "--unacked"]).stdout);
  assert.equal(claudeInbox.messages.length, 1);
  assert.equal(claudeInbox.messages[0].id, dispatched.request.request_id);

  const reviewBody = JSON.stringify({
    task_id: task.task_id,
    reviewer: "claude",
    owner: "codex",
    verdict: "approve",
    required_fixes: [],
    optional_suggestions: ["Mailbox reply imported after dispatch."],
    questions: []
  });
  run(cwd, [
    "mailbox",
    "send",
    "--from",
    "claude",
    "--to",
    "codex",
    "--kind",
    "reply",
    "--task",
    task.task_id,
    "--request-id",
    dispatched.request.request_id,
    "--in-reply-to",
    dispatched.request.request_id,
    "--subject",
    "Review complete",
    "--body",
    reviewBody
  ]);
  const afterMailboxReply = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(afterMailboxReply.claude_channel.queues.mailbox_replies, 1);
  assert.equal(afterMailboxReply.claude_channel.queues.pending.length, 0);
  assert.doesNotMatch(afterMailboxReply.next_actions.join("\n"), /Claude semantic ACK\/reply pending/);
  const imported = JSON.parse(run(cwd, ["review", "import", task.task_id, "--request-id", dispatched.request.request_id]).stdout);
  assert.equal(imported.ok, true);
  assert.equal(imported.review.verdict, "approve");
  assert.equal(imported.request_id, dispatched.request.request_id);
});

test("CLI smoke: channel steer creates a durable Claude ACK handle before live delivery", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const steer = JSON.parse(
    run(cwd, [
      "channel",
      "steer",
      "--kind",
      "ui_direction",
      "--task",
      "T-000006",
      "--goal",
      "G-000001",
      "--subject",
      "Read Codex UI direction",
      "--prompt",
      "From Codex: acknowledge this UI direction before continuing frontend work.",
      "--no-live"
    ]).stdout
  );

  assert.equal(steer.ok, true);
  assert.equal(steer.durable_ack.reply_required, true);
  assert.equal(steer.durable_ack.dispatch_state, "queued");
  assert.equal(steer.live_channel.skipped, true);
  assert.match(steer.next.claude, new RegExp(steer.durable_ack.mailbox_message_id));

  const inbox = JSON.parse(run(cwd, ["mailbox", "inbox", "--to", "claude", "--unacked"]).stdout);
  assert.equal(inbox.ok, true);
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].id, steer.durable_ack.mailbox_message_id);
  assert.equal(inbox.messages[0].request_id, steer.durable_ack.request_id);
  assert.equal(inbox.messages[0].reply_required, true);
  assert.equal(inbox.messages[0].request_kind, "ui_direction");
  assert.equal(inbox.messages[0].subject, "Read Codex UI direction");
  const shown = JSON.parse(run(cwd, ["mailbox", "show", steer.durable_ack.mailbox_message_id]).stdout);
  assert.match(shown.message.body, /Mailbox-first protocol/);
  assert.match(shown.message.body, /acknowledge receipt, state what you will do next, and answer the question or name the blocker/);

  const cockpit = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(cockpit.mailbox.pending_reply_required, 1);
  assert.match(cockpit.next_actions.join("\n"), /Claude semantic ACK\/reply pending/);
});

test("CLI smoke: daemon one-shot observes both inboxes, receipts advisory notes, and requires semantic replies only when asked", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const codexAdvisory = JSON.parse(
    run(cwd, [
      "mailbox",
      "send",
      "--from",
      "claude",
      "--to",
      "codex",
      "--kind",
      "notify",
      "--subject",
      "Thanks for the update",
      "--body",
      "Received your thank-you. I am continuing without needing a task-blocking reply."
    ]).stdout
  );
  const claudeRequest = JSON.parse(
    run(cwd, [
      "mailbox",
      "send",
      "--from",
      "codex",
      "--to",
      "claude",
      "--kind",
      "request",
      "--subject",
      "ACK required",
      "--body",
      "Please ACK and tell Codex what you will do next.",
      "--reply-required"
    ]).stdout
  );
  const heartbeat = JSON.parse(
    run(cwd, [
      "mailbox",
      "send",
      "--from",
      "claude",
      "--to",
      "codex",
      "--kind",
      "heartbeat",
      "--subject",
      "alive",
      "--body",
      "still active"
    ]).stdout
  );

  const daemon = JSON.parse(run(cwd, ["daemon", "run", "--once", "--roles", "codex,claude"]).stdout);
  assert.equal(daemon.ok, true);
  assert.equal(daemon.once, true);
  assert.equal(daemon.messages.length, 3);
  const byId = Object.fromEntries(daemon.messages.map((message) => [message.id, message]));
  assert.equal(byId[codexAdvisory.message.id].semantic_ack_required, false);
  assert.equal(byId[codexAdvisory.message.id].semantic_ack_instruction, undefined);
  assert.equal(byId[codexAdvisory.message.id].receipt_ack.required, true);
  assert.equal(byId[codexAdvisory.message.id].receipt_ack.created, true);
  assert.equal(byId[claudeRequest.message.id].semantic_ack_required, true);
  assert.match(byId[claudeRequest.message.id].semantic_ack_instruction, /State what you are going to do next/);
  assert.equal(byId[claudeRequest.message.id].receipt_ack.required, true);
  assert.equal(byId[claudeRequest.message.id].receipt_ack.created, true);
  assert.equal(byId[heartbeat.message.id].semantic_ack_required, false);
  assert.equal(byId[heartbeat.message.id].receipt_ack.required, false);

  const receiptAcks = JSON.parse(run(cwd, ["mailbox", "list", "--kind", "receipt_ack"]).stdout).messages;
  assert.equal(receiptAcks.length, 2);
  const receiptsByReplyTo = Object.fromEntries(receiptAcks.map((message) => [message.in_reply_to, message]));
  assert.equal(receiptsByReplyTo[codexAdvisory.message.id].from, "codex");
  assert.equal(receiptsByReplyTo[codexAdvisory.message.id].to, "claude");
  assert.equal(receiptsByReplyTo[claudeRequest.message.id].from, "claude");
  assert.equal(receiptsByReplyTo[claudeRequest.message.id].to, "codex");
  const shownReceipt = JSON.parse(run(cwd, ["mailbox", "show", receiptsByReplyTo[claudeRequest.message.id].id]).stdout);
  assert.match(shownReceipt.message.body, /A fuller semantic reply is still expected/);
  assert.match(shownReceipt.message.body, /separate from long-task check-ins/);
  const shownAdvisoryReceipt = JSON.parse(run(cwd, ["mailbox", "show", receiptsByReplyTo[codexAdvisory.message.id].id]).stdout);
  assert.match(shownAdvisoryReceipt.message.body, /No further semantic reply is required/);

  const events = JSON.parse(run(cwd, ["events", "--type", "daemon.semantic_ack_required"]).stdout).events;
  assert.equal(events.length, 1);
  assert.deepEqual(events.map((event) => event.detail.message_id), [claudeRequest.message.id]);
  const receiptEvents = JSON.parse(run(cwd, ["events", "--type", "daemon.receipt_ack_sent"]).stdout).events;
  assert.equal(receiptEvents.length, 2);
  const cockpit = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(cockpit.daemon.running, false);
  assert.equal(cockpit.mailbox.pending_receipt_ack, 0);
  assert.equal(cockpit.mailbox.recent_receipt_acks.length, 2);
  assert.equal(cockpit.mailbox.codex_inbox[0].informational, true);
  assert.equal(cockpit.mailbox.codex_inbox[0].semantic_ack_required, false);
  assert.match(cockpit.next_actions.join("\n"), /Start the receiver daemon/);
  assert.match(cockpit.next_actions.join("\n"), /Read Codex advisory mailbox/);
  assert.match(cockpit.next_actions.join("\n"), /Claude semantic ACK\/reply pending/);
  assert.doesNotMatch(cockpit.next_actions.find((action) => action.includes(codexAdvisory.message.id)) || "", /send semantic ACK\/reply/);
  assert.doesNotMatch(cockpit.next_actions.join("\n"), /Generate receipt ACK/);

  const daemonAgain = JSON.parse(run(cwd, ["daemon", "run", "--once", "--roles", "codex,claude"]).stdout);
  assert.equal(daemonAgain.messages.filter((message) => message.kind === "receipt_ack").length, 2);
  const receiptAcksAfterRepeat = JSON.parse(run(cwd, ["mailbox", "list", "--kind", "receipt_ack"]).stdout).messages;
  assert.equal(receiptAcksAfterRepeat.length, 2);
});

test("CLI smoke: daemon wakes live Claude when a Claude-bound mailbox request lands", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const argsFile = path.join(cwd, "claude-channel-args.txt");
  const promptCopy = path.join(cwd, "claude-channel-prompt.md");
  const fakeCli = path.join(binDir, "claude-channel");
  writeExecutable(fakeCli, [
    "#!/bin/sh",
    "printf '%s\\n' \"$@\" > \"$FAKE_ARGS_FILE\"",
    "if [ \"$1\" = \"ask-file\" ]; then",
    "  cp \"$2\" \"$FAKE_PROMPT_COPY\"",
    "  echo 'timed out waiting for Claude Code reply' >&2",
    "  exit 1",
    "fi",
    "exit 1"
  ]);
  const env = {
    ...process.env,
    AGENT_TEAM_CHANNEL_CLI: fakeCli,
    FAKE_ARGS_FILE: argsFile,
    FAKE_PROMPT_COPY: promptCopy
  };
  run(cwd, ["init"], env);
  const sessionFile = path.join(cwd, ".agent-team", "comms", "claude-channel", "session.json");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    JSON.stringify(
      {
        ok: true,
        target: "codex-thread",
        name: "codex-thread",
        endpoint: {
          endpoint_id: "ep_exact",
          display_name: "codex-thread"
        },
        delivery_ready: true
      },
      null,
      2
    )
  );
  const request = JSON.parse(
    run(
      cwd,
      [
        "mailbox",
        "send",
        "--from",
        "codex",
        "--to",
        "claude",
        "--kind",
        "request",
        "--task",
        "T-000123",
        "--subject",
        "Visible wake proof",
        "--body",
        "Please ACK through mailbox and keep working visibly.",
        "--reply-required"
      ],
      env
    ).stdout
  );

  const daemon = JSON.parse(run(cwd, ["daemon", "run", "--once", "--roles", "claude"], env).stdout);
  assert.equal(daemon.ok, true);
  assert.equal(daemon.once, true);
  assert.equal(daemon.messages.length, 1);
  assert.equal(daemon.messages[0].id, request.message.id);
  assert.equal(daemon.messages[0].live_push.required, true);
  assert.equal(daemon.messages[0].live_push.attempted, true);
  assert.equal(daemon.messages[0].live_push.target, "ep_exact");
  assert.equal(daemon.messages[0].live_push.result_state, "wake_sent_reply_pending");

  const args = fs.readFileSync(argsFile, "utf8").trim().split(/\r?\n/);
  assert.equal(args[0], "ask-file");
  assert.deepEqual(args.slice(args.indexOf("--timeout-ms"), args.indexOf("--timeout-ms") + 2), [
    "--timeout-ms",
    "1200"
  ]);
  assert.deepEqual(args.slice(args.indexOf("--to"), args.indexOf("--to") + 2), ["--to", "ep_exact"]);
  const prompt = fs.readFileSync(promptCopy, "utf8");
  assert.match(prompt, new RegExp(request.message.id));
  assert.match(prompt, /real-time wake-up copy only/);
  assert.match(prompt, /Reply command shape:/);
  assert.match(prompt, /Please ACK through mailbox/);

  const events = JSON.parse(run(cwd, ["events", "--type", "daemon.live_push_attempted"], env).stdout).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.message_id, request.message.id);
  assert.equal(events[0].detail.result_state, "wake_sent_reply_pending");
});

test("CLI smoke: daemon queues and delivers Codex wake payloads for Claude check-ins", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const payloadPathFile = path.join(cwd, "codex-wake-payload-path.txt");
  const fakeWake = path.join(binDir, "codex-wake");
  writeExecutable(fakeWake, [
    "#!/bin/sh",
    "printf '%s\\n' \"$1\" > \"$FAKE_PAYLOAD_PATH_FILE\"",
    "exit 0"
  ]);
  const env = {
    ...process.env,
    AGENT_TEAM_CODEX_WAKE_COMMAND: fakeWake,
    FAKE_PAYLOAD_PATH_FILE: payloadPathFile
  };
  run(cwd, ["init"], env);
  const checkin = JSON.parse(
    run(
      cwd,
      [
        "mailbox",
        "send",
        "--from",
        "claude",
        "--to",
        "codex",
        "--kind",
        "checkin",
        "--task",
        "T-000456",
        "--subject",
        "Realtime Codex ping",
        "--body",
        "Claude has a useful update while Codex is busy."
      ],
      env
    ).stdout
  );

  const daemon = JSON.parse(run(cwd, ["daemon", "run", "--once", "--roles", "codex"], env).stdout);
  assert.equal(daemon.ok, true);
  assert.equal(daemon.messages.length, 1);
  assert.equal(daemon.messages[0].id, checkin.message.id);
  assert.equal(daemon.messages[0].codex_push.required, true);
  assert.equal(daemon.messages[0].codex_push.attempted, true);
  assert.equal(daemon.messages[0].codex_push.result_state, "delivered");

  const payloadPath = fs.readFileSync(payloadPathFile, "utf8").trim();
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  assert.equal(payload.event, "codex_mailbox_wake");
  assert.equal(payload.message.id, checkin.message.id);
  assert.equal(payload.message.to, "codex");
  assert.match(payload.body_preview, /useful update/);

  const wakeRows = fs
    .readFileSync(path.join(cwd, ".agent-team", "comms", "codex-wake", "wake.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(wakeRows.length, 1);
  assert.equal(wakeRows[0].message_id, checkin.message.id);

  const events = JSON.parse(run(cwd, ["events", "--type", "daemon.codex_push_attempted"], env).stdout).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.message_id, checkin.message.id);
  assert.equal(events[0].detail.result_state, "delivered");
});

test("CLI smoke: duplicate deterministic receipt ACK ids do not create cockpit noise", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const inbound = JSON.parse(
    run(cwd, [
      "mailbox",
      "send",
      "--from",
      "claude",
      "--to",
      "codex",
      "--kind",
      "notify",
      "--subject",
      "Friendly ping",
      "--body",
      "This should get one visible receipt ACK, not a pile of duplicates."
    ]).stdout
  );

  const first = JSON.parse(run(cwd, ["daemon", "run", "--once", "--roles", "codex"]).stdout);
  assert.equal(first.messages[0].receipt_ack.created, true);
  const duplicate = JSON.parse(
    run(cwd, [
      "mailbox",
      "send",
      "--id",
      `receipt_${inbound.message.id}`,
      "--from",
      "codex",
      "--to",
      "claude",
      "--kind",
      "receipt_ack",
      "--in-reply-to",
      inbound.message.id,
      "--request-id",
      inbound.message.id,
      "--subject",
      "Duplicate receipt ACK",
      "--body",
      "This should be idempotent and not append a second row."
    ]).stdout
  );
  assert.equal(duplicate.idempotent, true);

  const receiptAcks = JSON.parse(run(cwd, ["mailbox", "list", "--kind", "receipt_ack"]).stdout).messages;
  assert.equal(receiptAcks.length, 1);
  const cockpit = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(cockpit.mailbox.recent_receipt_acks.length, 1);
  assert.equal(cockpit.mailbox.duplicate_receipt_acks_collapsed, 0);
  assert.doesNotMatch(cockpit.next_actions.join("\n"), /Duplicate receipt ACK/);
});

test("CLI smoke: mailbox watch streams new Claude messages while Codex keeps running", async (t) => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const child = spawn(process.execPath, [cli, "mailbox", "watch", "--to", "codex", "--unacked", "--interval-ms", "100"], {
    cwd,
    encoding: "utf8"
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let resolved = false;
  t.after(() => {
    if (!child.killed) child.kill("SIGINT");
  });
  const streamed = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("Realtime ping")) {
        resolved = true;
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      if (!resolved) reject(new Error(`mailbox watch exited before streaming message: ${code}\n${stderr}`));
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  run(cwd, [
    "mailbox",
    "send",
    "--from",
    "claude",
    "--to",
    "codex",
    "--kind",
    "heartbeat",
    "--subject",
    "Realtime ping",
    "--body",
    "Claude heartbeat landed while watcher was already active."
  ]);
  await Promise.race([
    streamed,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`mailbox watch did not stream in time\nstdout:\n${stdout}\nstderr:\n${stderr}`)), 3000))
  ]);
  child.kill("SIGINT");
  assert.match(stdout, /Realtime ping/);
});

test("CLI smoke: mailbox imports only the matching request kind when request id is omitted", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput({ status: "review" }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);

  const reviewRequest = JSON.parse(run(cwd, ["review", "request", task.task_id, "--prompt", "Review backend changes"]).stdout);
  const regroundRequest = JSON.parse(run(cwd, ["reground", "request", task.task_id, "--prompt", "Re-ground this task"]).stdout);
  assert.equal(reviewRequest.adapter, "mailbox");
  assert.equal(regroundRequest.adapter, "mailbox");

  const regroundBody = JSON.stringify({
    task_id: task.task_id,
    source: "claude",
    base_tree_hash: "unknown",
    restated_objective: task.objective,
    restated_acceptance: task.acceptance_criteria,
    active_tasks_state: ["Still in review"],
    open_decisions: [],
    divergences_from_files: [],
    corrections: [],
    open_questions: []
  });
  const regroundReply = JSON.parse(
    run(cwd, [
      "mailbox",
      "send",
      "--from",
      "claude",
      "--to",
      "codex",
      "--kind",
      "reply",
      "--in-reply-to",
      regroundRequest.request_id,
      "--subject",
      "Reground response",
      "--body",
      regroundBody
    ]).stdout
  );
  assert.equal(regroundReply.message.request_kind, "reground");
  assert.equal(regroundReply.message.task_id, task.task_id);

  const wrongImport = spawnSync(process.execPath, [cli, "review", "import", task.task_id], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(wrongImport.status, 1);
  assert.match(wrongImport.stderr, /no review response found/);

  const reviewBody = JSON.stringify({
    task_id: task.task_id,
    reviewer: "claude",
    owner: "codex",
    verdict: "approve",
    required_fixes: [],
    optional_suggestions: ["Correct review reply selected."],
    questions: []
  });
  const reviewReply = JSON.parse(
    run(cwd, [
      "mailbox",
      "send",
      "--from",
      "claude",
      "--to",
      "codex",
      "--kind",
      "reply",
      "--in-reply-to",
      reviewRequest.request_id,
      "--subject",
      "Review response",
      "--body",
      reviewBody
    ]).stdout
  );
  assert.equal(reviewReply.message.request_kind, "review");
  assert.equal(reviewReply.message.task_id, task.task_id);

  const imported = JSON.parse(run(cwd, ["review", "import", task.task_id]).stdout);
  assert.equal(imported.ok, true);
  assert.equal(imported.request_id, reviewRequest.request_id);
  assert.equal(imported.review.verdict, "approve");
});

test("CLI smoke: review import parses legacy mailbox body objects without wrapper fallback", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput({ status: "review" }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const request = JSON.parse(run(cwd, ["review", "request", task.task_id, "--prompt", "Review backend task"]).stdout);
  const legacyMessage = {
    id: "msg_legacy_object_body",
    source: "agent-mailbox",
    from: "claude",
    to: "codex",
    kind: "reply",
    subject: "Legacy object-body review",
    task_id: task.task_id,
    goal_id: task.goal_id,
    request_id: request.request_id,
    in_reply_to: request.request_id,
    request_kind: "review",
    body_inline: {
      task_id: task.task_id,
      reviewer: "claude",
      owner: "codex",
      verdict: "approve",
      required_fixes: [],
      optional_suggestions: ["Legacy object body imported without parsing the wrapper."],
      questions: []
    },
    advisory_only: true,
    codex_state_authority: true,
    realtime_delivery: "mailbox-watch",
    created_at: new Date().toISOString()
  };
  fs.appendFileSync(path.join(cwd, ".agent-team", "comms", "mailbox.jsonl"), `${JSON.stringify(legacyMessage)}\n`);
  const imported = JSON.parse(run(cwd, ["review", "import", task.task_id, "--request-id", request.request_id]).stdout);
  assert.equal(imported.ok, true);
  assert.equal(imported.review.verdict, "approve");
  assert.equal(imported.review.optional_suggestions[0], "Legacy object body imported without parsing the wrapper.");
});

test("CLI smoke: cockpit suppresses stale completed-task mailbox noise", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput({ status: "review" }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const dispatched = JSON.parse(
    run(cwd, [
      "channel",
      "dispatch",
      "--kind",
      "review",
      "--task",
      task.task_id,
      "--prompt",
      "Review this backend task while Codex keeps moving."
    ]).stdout
  );
  const noisy = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(noisy.claude_channel.queues.pending.length, 1);
  assert.equal(noisy.mailbox.claude_unread, 1);
  assert.equal(noisy.mailbox.pending_receipt_ack, 1);
  assert.equal(noisy.mailbox.pending_reply_required, 1);

  const reviewFile = path.join(cwd, "review.json");
  fs.writeFileSync(
    reviewFile,
    JSON.stringify(
      {
        reviewer: "claude",
        owner: "codex",
        verdict: "approve",
        required_fixes: [],
        optional_suggestions: [],
        questions: []
      },
      null,
      2
    )
  );
  run(cwd, ["review", task.task_id, "--json", reviewFile]);
  run(cwd, ["merge", task.task_id, "--strategy", "serial", "--note", "Completed despite stale dispatch"]);
  run(cwd, ["verify", "run", task.task_id]);
  run(cwd, ["done", task.task_id]);

  const clean = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(clean.tasks.done, 1);
  assert.equal(clean.claude_channel.queues.pending.length, 0);
  assert.equal(clean.claude_channel.queues.stale_completed_pending, 1);
  assert.equal(clean.mailbox.claude_unread, 0);
  assert.equal(clean.mailbox.pending_receipt_ack, 0);
  assert.equal(clean.mailbox.pending_reply_required, 0);
  assert.equal(clean.mailbox.stale_completed_unread, 1);
  assert.equal(clean.mailbox.stale_completed_receipt_ack, 1);
  assert.equal(clean.mailbox.stale_completed_reply_required, 1);
  assert.doesNotMatch(clean.next_actions.join("\n"), /Claude semantic ACK\/reply pending/);
  assert.doesNotMatch(clean.next_actions.join("\n"), /Generate receipt ACK/);
  assert.equal(dispatched.request.task_id, task.task_id);
});

test("CLI smoke: mailbox send-batch verifies multi-reply delivery from any cwd", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const firstTaskFile = path.join(cwd, "task-1.json");
  const secondTaskFile = path.join(cwd, "task-2.json");
  fs.writeFileSync(firstTaskFile, JSON.stringify(backendTaskInput({ status: "review", title: "Backend task one" }), null, 2));
  fs.writeFileSync(secondTaskFile, JSON.stringify(backendTaskInput({ status: "review", title: "Backend task two" }), null, 2));
  const firstTask = JSON.parse(run(cwd, ["tasks", "create", "--json", firstTaskFile]).stdout);
  const secondTask = JSON.parse(run(cwd, ["tasks", "create", "--json", secondTaskFile]).stdout);
  const firstRequest = JSON.parse(run(cwd, ["review", "request", firstTask.task_id, "--prompt", "Review first backend task"]).stdout);
  const secondRequest = JSON.parse(run(cwd, ["review", "request", secondTask.task_id, "--prompt", "Review second backend task"]).stdout);
  const batchFile = path.join(cwd, "batch.json");
  fs.writeFileSync(
    batchFile,
    JSON.stringify(
      {
        defaults: {
          from: "claude",
          to: "codex",
          kind: "reply",
          subject: "Review verdict"
        },
        messages: [
          {
            task_id: firstTask.task_id,
            request_id: firstRequest.request_id,
            in_reply_to: firstRequest.request_id,
            body: {
              task_id: firstTask.task_id,
              reviewer: "claude",
              owner: "codex",
              verdict: "approve",
              required_fixes: [],
              optional_suggestions: ["Batch delivery landed first review."],
              questions: []
            }
          },
          {
            task_id: secondTask.task_id,
            request_id: secondRequest.request_id,
            in_reply_to: secondRequest.request_id,
            body: {
              task_id: secondTask.task_id,
              reviewer: "claude",
              owner: "codex",
              verdict: "approve",
              required_fixes: [],
              optional_suggestions: ["Batch delivery landed second review."],
              questions: []
            }
          }
        ]
      },
      null,
      2
    )
  );
  const remoteCwd = fs.mkdtempSync(path.join(cwd, "remote-job-"));
  const delivered = spawnSync(process.execPath, [cli, "--cwd", cwd, "mailbox", "send-batch", "--json", batchFile], {
    cwd: remoteCwd,
    encoding: "utf8"
  });
  assert.equal(delivered.status, 0, delivered.stderr);
  const batch = JSON.parse(delivered.stdout);
  assert.equal(batch.ok, true);
  assert.equal(batch.expected, 2);
  assert.equal(batch.delivered, 2);
  assert.equal(batch.failed, 0);
  const replies = JSON.parse(run(cwd, ["mailbox", "list", "--kind", "reply"]).stdout);
  assert.equal(replies.messages.length, 2);
  const firstImport = JSON.parse(run(cwd, ["review", "import", firstTask.task_id, "--request-id", firstRequest.request_id]).stdout);
  const secondImport = JSON.parse(run(cwd, ["review", "import", secondTask.task_id, "--request-id", secondRequest.request_id]).stdout);
  assert.equal(firstImport.review.verdict, "approve");
  assert.equal(secondImport.review.verdict, "approve");
});

test("CLI smoke: mailbox send-batch failures recommend confirmation-gated self-heal", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const badBatchFile = path.join(cwd, "bad-batch.json");
  fs.writeFileSync(
    badBatchFile,
    JSON.stringify(
      {
        messages: [
          {
            from: "claude",
            to: "codex",
            kind: "bogus",
            subject: "Bad review",
            body: "This should fail validation before writing."
          }
        ]
      },
      null,
      2
    )
  );
  const failed = spawnSync(process.execPath, [cli, "mailbox", "send-batch", "--json", badBatchFile], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(failed.status, 1);
  const result = JSON.parse(failed.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.self_heal_recommendation.recommendation.requires_user_confirmation, true);
  assert.match(result.self_heal_recommendation.recommendation.recommendation, /mailbox send-batch failed/);
  const context = JSON.parse(run(cwd, ["self-heal", "context", "--limit", "5"]).stdout);
  assert.equal(context.pending_tool_change_requests.length, 1);
  assert.match(context.pending_tool_change_requests[0].recommendation, /hand-rolled shell loops/);
});

test("CLI smoke: durable await reply watches mailbox by request id", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput({ status: "review" }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const dispatched = JSON.parse(
    run(cwd, [
      "channel",
      "dispatch",
      "--kind",
      "review",
      "--task",
      task.task_id,
      "--prompt",
      "Review this backend task without blocking Codex."
    ]).stdout
  );
  const waiting = spawnSync(process.execPath, [cli, "await", "reply", "--request-id", dispatched.request.request_id, "--once"], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(waiting.status, 1);
  assert.equal(JSON.parse(waiting.stdout).state, "waiting");
  run(cwd, [
    "mailbox",
    "send",
    "--from",
    "claude",
    "--to",
    "codex",
    "--kind",
    "checkin",
    "--task",
    task.task_id,
    "--subject",
    "Still reviewing",
    "--body",
    "I am checking the backend acceptance criteria."
  ]);
  run(cwd, [
    "mailbox",
    "send",
    "--from",
    "claude",
    "--to",
    "codex",
    "--kind",
    "reply",
    "--request-id",
    dispatched.request.request_id,
    "--in-reply-to",
    dispatched.request.request_id,
    "--subject",
    "Review ACK",
    "--body",
    "ACK: received. I reviewed it and approve."
  ]);
  const answered = JSON.parse(run(cwd, ["await", "reply", "--request-id", dispatched.request.request_id, "--once"]).stdout);
  assert.equal(answered.ok, true);
  assert.equal(answered.state, "answered");
  assert.equal(answered.mailbox_is_truth, true);
  assert.match(answered.reply.body, /approve/);
  assert.equal(answered.latest_activity.length, 1);
});

test("CLI smoke: browser proof findings reattach automatically during verify run", () => {
  const cwd = tempRoot();
  initGitRepo(cwd);
  run(cwd, ["init"]);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(frontendTaskInput({ status: "verifying" }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const reviewFile = path.join(cwd, "review.json");
  fs.writeFileSync(
    reviewFile,
    JSON.stringify(
      {
        reviewer: "codex",
        owner: "claude",
        verdict: "approve",
        required_fixes: [],
        optional_suggestions: [],
        questions: []
      },
      null,
      2
    )
  );
  run(cwd, ["review", task.task_id, "--json", reviewFile]);
  const browser = JSON.parse(run(cwd, ["verify", "browser", task.task_id, "--url", "fixture.html", "--fake"]).stdout);
  assert.equal(browser.ok, true);
  assert.ok(browser.artifacts.findings);
  assert.ok(fs.existsSync(path.join(cwd, browser.artifacts.findings)));
  const proof = JSON.parse(run(cwd, ["verify", "run", task.task_id]).stdout);
  assert.deepEqual(proof.manifest.artifacts.browser_runs, [browser.artifacts.browser_run]);
  assert.deepEqual(proof.manifest.artifacts.screenshots, [browser.artifacts.screenshot]);
  assert.deepEqual(proof.manifest.artifacts.console_checks, [browser.artifacts.console_check]);
  assert.deepEqual(proof.manifest.artifacts.browser_findings, [browser.artifacts.findings]);
  assert.equal(proof.manifest.reused_browser_proof.run_id, browser.run_id);
});

test("CLI smoke: closeout generates GOAL_REPORT and retention policy is explicit", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const goal = JSON.parse(run(cwd, ["goal", "new", "--title", "Closeout", "--objective", "Finish and report"]).stdout);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(path.join(cwd, "marker.txt"), "closeout\n");
  fs.writeFileSync(
    taskFile,
    JSON.stringify(
      backendTaskInput({
        goal_id: goal.goal_id,
        status: "review",
        proof: {
          commands: ["node -e \"require('fs').readFileSync('marker.txt','utf8')\""],
          requires_browser: false,
          requires_screenshot: false
        }
      }),
      null,
      2
    )
  );
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const reviewFile = path.join(cwd, "review.json");
  fs.writeFileSync(
    reviewFile,
    JSON.stringify(
      {
        reviewer: "claude",
        owner: "codex",
        verdict: "approve",
        required_fixes: [],
        optional_suggestions: [],
        questions: []
      },
      null,
      2
    )
  );
  run(cwd, ["review", task.task_id, "--json", reviewFile]);
  run(cwd, ["merge", task.task_id, "--strategy", "serial"]);
  run(cwd, ["verify", "run", task.task_id]);
  run(cwd, ["done", task.task_id]);
  const close = JSON.parse(run(cwd, ["closeout", "--goal", goal.goal_id]).stdout);
  assert.equal(close.ok, true);
  assert.match(close.report.report_path, /GOAL_REPORT\.md$/);
  assert.ok(fs.existsSync(close.report.report_path));
  assert.match(fs.readFileSync(close.report.report_path, "utf8"), /Mailbox is truth: true/);
  const report = JSON.parse(run(cwd, ["goal", "report", "--goal", goal.goal_id]).stdout);
  assert.ok(fs.existsSync(report.report_path));
  const retention = JSON.parse(run(cwd, ["retention", "policy", "--goal", goal.goal_id]).stdout);
  assert.equal(retention.ok, true);
  assert.ok(fs.existsSync(retention.markdown_path));
  assert.match(fs.readFileSync(retention.markdown_path, "utf8"), /This command does not delete anything/);
});

test("CLI smoke: port check reports occupied ports and a next free candidate", () => {
  const cwd = tempRoot();
  const result = JSON.parse(
    run(cwd, ["port", "check", "--port", "4111", "--next"], {
      ...process.env,
      AGENT_TEAM_FAKE_OCCUPIED_PORTS: "4111,4112"
    }).stdout
  );
  assert.equal(result.ok, true);
  assert.equal(result.fake, true);
  assert.equal(result.occupied, true);
  assert.equal(result.selected_port, 4113);
  assert.equal(result.action, "use_next_free_port");
});

test("CLI smoke: malformed mailbox rows surface in cockpit and block imports", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput({ status: "review" }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const reviewRequest = JSON.parse(run(cwd, ["review", "request", task.task_id, "--prompt", "Review backend changes"]).stdout);
  fs.appendFileSync(path.join(cwd, ".agent-team", "comms", "mailbox.jsonl"), "{not-json\n");

  const inbox = JSON.parse(run(cwd, ["mailbox", "inbox", "--to", "claude"]).stdout);
  assert.equal(inbox.ok, false);
  assert.equal(inbox.diagnostics.malformed_total, 1);

  const cockpit = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(cockpit.mailbox.diagnostics.malformed_total, 1);
  assert.match(cockpit.next_actions.join("\n"), /Repair mailbox JSONL corruption/);

  const reviewBody = JSON.stringify({
    task_id: task.task_id,
    reviewer: "claude",
    owner: "codex",
    verdict: "approve",
    required_fixes: [],
    optional_suggestions: [],
    questions: []
  });
  run(cwd, [
    "mailbox",
    "send",
    "--from",
    "claude",
    "--to",
    "codex",
    "--kind",
    "reply",
    "--in-reply-to",
    reviewRequest.request_id,
    "--subject",
    "Review response",
    "--body",
    reviewBody
  ]);
  const imported = spawnSync(process.execPath, [cli, "review", "import", task.task_id, "--request-id", reviewRequest.request_id], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(imported.status, 1);
  assert.match(imported.stderr, /mailbox log contains malformed JSONL rows/);
});

test("CLI smoke: coordination runs are visible in cockpit and SQLite", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const goal = JSON.parse(run(cwd, ["goal", "new", "--title", "Harness", "--objective", "Track orchestration"]).stdout);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput({ goal_id: goal.goal_id }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const coordination = JSON.parse(
    run(cwd, [
      "run",
      "start",
      "--kind",
      "dev",
      "--title",
      "Backend slice",
      "--goal",
      goal.goal_id,
      "--task",
      task.task_id,
      "--mode",
      "dev",
      "--summary",
      "Codex owns the backend slice while Claude reviews."
    ]).stdout
  );
  assert.equal(coordination.run_id, "R-000001");
  assert.equal(coordination.status, "active");
  const listed = JSON.parse(run(cwd, ["run", "list", "--status", "active"]).stdout);
  assert.equal(listed.runs.length, 1);
  const shown = JSON.parse(run(cwd, ["run", "show", coordination.run_id]).stdout);
  assert.equal(shown.run.title, "Backend slice");
  const cockpit = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(cockpit.runs.total, 1);
  assert.equal(cockpit.runs.active[0].run_id, coordination.run_id);
  const cockpitText = run(cwd, ["cockpit", "--no-live-channel"]).stdout;
  assert.match(cockpitText, /Coordination Runs/);
  assert.match(cockpitText, /R-000001 \[active\] dev owner=codex task=T-000001/);
  const completed = JSON.parse(
    run(cwd, [
      "run",
      "complete",
      coordination.run_id,
      "--summary",
      "Backend slice passed focused tests.",
      "--evidence",
      "npm test -- --test-name-pattern RUN-1"
    ]).stdout
  );
  assert.equal(completed.status, "complete");
  const dbRows = JSON.parse(run(cwd, ["db", "query", "--sql", "select run_id,status,task_id from runs"]).stdout);
  assert.deepEqual(dbRows.rows, [{ run_id: "R-000001", status: "complete", task_id: task.task_id }]);
  const events = JSON.parse(run(cwd, ["events", "--type", "run.complete"]).stdout).events;
  assert.equal(events[0].run_id, coordination.run_id);
});

test("CLI smoke: promote-dev refuses missing planning unless degraded reason is recorded", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const goal = JSON.parse(run(cwd, ["goal", "new", "--title", "Harness", "--objective", "Plan first"]).stdout);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput({ goal_id: goal.goal_id, status: "planning" }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const failed = spawnSync(process.execPath, [cli, "promote-dev"], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /missing codex_plan, claude_plan, reconciled_plan, decision/);
  const promoted = JSON.parse(run(cwd, ["promote-dev", "--degraded-reason", "Claude unavailable during local channel setup"]).stdout);
  assert.deepEqual(promoted.promoted, [task.task_id]);
  assert.equal(promoted.planning[goal.goal_id].degraded, true);
  const events = JSON.parse(run(cwd, ["events", "--goal", goal.goal_id, "--type", "plan.degraded_dev_promotion"]).stdout).events;
  assert.equal(events.length, 1);
});

test("CLI smoke: promote-dev accepts reconciled Codex and Claude planning evidence", () => {
  const cwd = tempRoot();
  run(cwd, ["init"]);
  const goal = JSON.parse(run(cwd, ["goal", "new", "--title", "Harness", "--objective", "Plan first"]).stdout);
  run(cwd, ["plan", "codex", "--goal", goal.goal_id, "--text", "Codex proposes backend/proof tasks."]);
  const claudePlan = path.join(cwd, "claude-plan.md");
  fs.writeFileSync(claudePlan, "Claude critique recovered from a durable file.");
  run(cwd, ["plan", "claude", "--goal", goal.goal_id, "--file", claudePlan]);
  run(cwd, ["plan", "reconcile", "--goal", goal.goal_id, "--text", "Use Codex for proof and Claude for frontend."]);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput({ goal_id: goal.goal_id, status: "planning" }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const promoted = JSON.parse(run(cwd, ["promote-dev"]).stdout);
  assert.deepEqual(promoted.promoted, [task.task_id]);
  assert.equal(promoted.planning[goal.goal_id].degraded, false);
});

test("CLI smoke: channel install manages the Claude channel bridge below the harness", () => {
  const cwd = tempRoot();
  const fakeBin = tempRoot();
  const toolsDir = tempRoot();
  const binDir = tempRoot();
  writeExecutable(path.join(fakeBin, "npm"), [
    "#!/bin/sh",
    "PREFIX=''",
    "while [ \"$#\" -gt 0 ]; do",
    "  case \"$1\" in",
    "    --prefix)",
    "      PREFIX=\"$2\"",
    "      shift 2",
    "      ;;",
    "    *)",
    "      shift",
    "      ;;",
    "  esac",
    "done",
    "if [ -z \"$PREFIX\" ]; then echo 'missing --prefix' >&2; exit 2; fi",
    "mkdir -p \"$PREFIX/node_modules/.bin\"",
    "cat > \"$PREFIX/node_modules/.bin/claude-channel\" <<'BIN'",
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'claude-channel-cli 0.3.0'; exit 0; fi",
    "if [ \"$1\" = \"status\" ]; then echo '{\"reachable\":false,\"health\":{\"ok\":false}}'; exit 1; fi",
    "if [ \"$1\" = \"list\" ]; then echo '{\"targets\":[]}'; exit 0; fi",
    "echo '{}'",
    "exit 0",
    "BIN",
    "chmod +x \"$PREFIX/node_modules/.bin/claude-channel\"",
    "cat > \"$PREFIX/node_modules/.bin/claude-channel-server\" <<'BIN'",
    "#!/bin/sh",
    "echo 'server'",
    "BIN",
    "chmod +x \"$PREFIX/node_modules/.bin/claude-channel-server\""
  ]);
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    AGENT_TEAM_TOOLS_DIR: toolsDir
  };
  const installed = JSON.parse(
    run(
      cwd,
      [
        "channel",
        "install",
        "--version",
        "0.3.0",
        "--tools-dir",
        toolsDir,
        "--bin-dir",
        binDir,
        "--no-setup-mcp"
      ],
      env
    ).stdout
  );
  assert.equal(installed.ok, true);
  assert.equal(installed.package, "claude-channel-cli");
  assert.equal(installed.ready, true);
  assert.equal(installed.setup_mcp.skipped, true);
  assert.equal(fs.existsSync(path.join(binDir, "claude-channel")), true);
  assert.equal(fs.existsSync(path.join(binDir, "claude-channel-server")), true);
  const status = JSON.parse(run(cwd, ["channel", "status"], env).stdout);
  assert.equal(status.ok, false);
  assert.equal(status.source, "managed");
  assert.equal(status.path, installed.claude_channel.path);
});

test("CLI smoke: doctor --fix installs the bridge and keeps remaining readiness issues honest", () => {
  const cwd = tempRoot();
  const fakeBin = tempRoot();
  const toolsDir = tempRoot();
  const binDir = tempRoot();
  writeExecutable(path.join(fakeBin, "npm"), [
    "#!/bin/sh",
    "PREFIX=''",
    "while [ \"$#\" -gt 0 ]; do",
    "  case \"$1\" in",
    "    --prefix)",
    "      PREFIX=\"$2\"",
    "      shift 2",
    "      ;;",
    "    *)",
    "      shift",
    "      ;;",
    "  esac",
    "done",
    "mkdir -p \"$PREFIX/node_modules/.bin\"",
    "cat > \"$PREFIX/node_modules/.bin/claude-channel\" <<'BIN'",
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo '0.3.0'; exit 0; fi",
    "if [ \"$1\" = \"status\" ]; then echo '{\"reachable\":false,\"health\":{\"ok\":false}}'; exit 1; fi",
    "if [ \"$1\" = \"list\" ]; then echo '{\"targets\":[]}'; exit 0; fi",
    "exit 0",
    "BIN",
    "chmod +x \"$PREFIX/node_modules/.bin/claude-channel\""
  ]);
  const env = {
    ...process.env,
    PATH: `${fakeBin}:/bin:/usr/bin`,
    AGENT_TEAM_TOOLS_DIR: toolsDir,
    AGENT_TEAM_BIN_DIR: binDir
  };
  const result = spawnSync(process.execPath, [cli, "doctor", "--fix", "--no-setup-mcp"], {
    cwd,
    env,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  const doctor = JSON.parse(result.stdout);
  assert.equal(doctor.fix_attempted, true);
  assert.equal(doctor.install.ok, true);
  assert.equal(doctor.claude_channel_cli.ok, true);
  assert.equal(doctor.claude_channel_cli.source, "managed");
  assert.match(doctor.issues.join("\n"), /Claude Code CLI is not installed/);
});

test("CLI smoke: start auto-ensures a named Claude side", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const readyFile = path.join(cwd, "ready");
  writeExecutable(path.join(binDir, "claude-channel"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ -f \"$FAKE_READY\" ]; then",
    "    echo '{\"target\":\"codex-thread\",\"endpoint\":{\"endpoint_id\":\"ep_fake\",\"display_name\":\"codex-thread\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false}}'",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  echo '{\"targets\":[]}'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  writeExecutable(path.join(binDir, "claude"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"max\"}'",
    "  exit 0",
    "fi",
    "touch \"$FAKE_READY\"",
    "echo 'backgrounded - fake123 - codex-thread'",
    "exit 0"
  ]);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_READY: readyFile
  };
  const start = JSON.parse(
    run(
      cwd,
      ["start", "--name", "codex-thread", "--timeout-ms", "1000", "--poll-ms", "10", "--launch-mode", "background"],
      env
    ).stdout
  );
  assert.equal(start.claude_channel_startup.ok, true);
  assert.equal(start.claude_channel_startup.action, "started");
  assert.equal(start.claude_channel.name, "codex-thread");
  assert.equal(start.question, "Do you want Planning Mode or Dev Mode?");
});

test("CLI smoke: start can launch Claude from an explicit project directory", () => {
  const cwd = tempRoot();
  const projectDir = tempRoot();
  const binDir = tempRoot();
  const readyFile = path.join(projectDir, "ready");
  writeExecutable(path.join(binDir, "claude-channel"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ -f \"$FAKE_READY\" ]; then",
    "    echo '{\"target\":\"codex-thread\",\"endpoint\":{\"endpoint_id\":\"ep_fake\",\"display_name\":\"codex-thread\",\"project_dir\":\"'$PWD'\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false}}'",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  echo '{\"targets\":[]}'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  writeExecutable(path.join(binDir, "claude"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"max\"}'",
    "  exit 0",
    "fi",
    "printf '%s\\n' \"$@\" > \"$FAKE_ARGS_FILE\"",
    "touch \"$FAKE_READY\"",
    "echo 'backgrounded - fake123 - codex-thread'",
    "exit 0"
  ]);
  const argsFile = path.join(projectDir, "claude-args.txt");
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_READY: readyFile,
    FAKE_ARGS_FILE: argsFile
  };
  const start = JSON.parse(
    run(
      cwd,
      [
        "start",
        "--name",
        "codex-thread",
        "--project-dir",
        projectDir,
        "--timeout-ms",
        "1000",
        "--poll-ms",
        "10",
        "--launch-mode",
        "background"
      ],
      env
    ).stdout
  );
  assert.equal(start.root, path.join(fs.realpathSync.native(cwd), ".agent-team"));
  assert.equal(start.claude_channel_startup.ok, true);
  assert.equal(start.claude_channel_startup.action, "started");
  assert.equal(start.claude_channel_startup.project_dir, fs.realpathSync.native(projectDir));
  assert.equal(start.claude_channel_startup.harness_cwd, fs.realpathSync.native(cwd));
  assert.equal(start.claude_channel_startup.command.env.CLAUDE_CHANNEL_PROJECT_DIR, fs.realpathSync.native(projectDir));
  assert.equal(start.claude_channel.project_dir, fs.realpathSync.native(projectDir));
  const launchArgs = fs.readFileSync(argsFile, "utf8");
  assert.equal(launchArgs.includes(cli), true);
  assert.equal(launchArgs.includes(fs.realpathSync.native(cwd)), true);
  assert.equal(launchArgs.includes(path.join(projectDir, "agent-team", "src", "cli.js")), false);
  const cockpit = JSON.parse(run(cwd, ["cockpit", "--json"], env).stdout);
  assert.equal(cockpit.claude_channel.session.project_dir, fs.realpathSync.native(projectDir));
  assert.equal(cockpit.claude_channel.session.harness_cwd, fs.realpathSync.native(cwd));
  assert.equal(cockpit.claude_channel.runtime.ok, true);
  assert.equal(cockpit.claude_channel.runtime.parsed.endpoint.project_dir, fs.realpathSync.native(projectDir));
});

test("CLI smoke: cockpit reports loaded Claude when local health fetch is blocked", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  writeExecutable(path.join(binDir, "claude-channel"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  printf '%s\\n' '{\"target\":\"codex-thread\",\"endpoint\":{\"endpoint_id\":\"ep_loaded\",\"display_name\":\"codex-thread\",\"project_dir\":\"'$PWD'\",\"pid\":'$FAKE_ENDPOINT_PID',\"last_seen_seconds\":1},\"reachable\":false,\"health\":{\"ok\":false,\"error\":\"channel server is not reachable: fetch failed\"}}'",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  printf '%s\\n' '{\"targets\":[{\"target\":\"ep_loaded\",\"endpoint_id\":\"ep_loaded\",\"display_name\":\"codex-thread\",\"project_dir\":\"'$PWD'\",\"pid\":'$FAKE_ENDPOINT_PID',\"last_seen_seconds\":1}]}'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  const sessionDir = path.join(cwd, ".agent-team", "comms", "claude-channel");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "session.json"),
    JSON.stringify(
      {
        ok: true,
        action: "started",
        name: "codex-thread",
        target: "codex-thread",
        launch_mode: "visible",
        reply_ready: "unchecked"
      },
      null,
      2
    )
  );
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_ENDPOINT_PID: String(process.pid)
  };
  const status = JSON.parse(run(cwd, ["channel", "status", "--target", "codex-thread"], env).stdout);
  assert.equal(status.ok, false);
  assert.equal(status.delivery_ready, false);
  assert.equal(status.presence_ok, true);
  assert.equal(status.status_kind, "loaded_fetch_failed");
  const cockpit = JSON.parse(run(cwd, ["cockpit", "--json", "--target", "codex-thread"], env).stdout);
  assert.equal(cockpit.claude_channel.runtime.ok, false);
  assert.equal(cockpit.claude_channel.runtime.presence_ok, true);
  assert.equal(cockpit.claude_channel.runtime.status_kind, "loaded_fetch_failed");
  const text = run(cwd, ["cockpit", "--target", "codex-thread"], env).stdout;
  assert.match(text, /Claude: loaded-channel-unverified/);
  assert.doesNotMatch(text, /Claude: not-live/);
  assert.match(text, /presence=loaded/);
});

test("CLI smoke: start does not expose stale raw channel diagnostics after startup failure", () => {
  const cwd = tempRoot();
  const sessionDir = path.join(cwd, ".agent-team", "comms", "claude-channel");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "session.json"),
    JSON.stringify(
      {
        ok: true,
        action: "reused",
        status: {
          stdout: "token path /home/example/.claude-channel/token",
          parsed: {
            token_path: "/home/example/.claude-channel/token",
            endpoints_path: "/home/example/.claude-channel/endpoints"
          }
        }
      },
      null,
      2
    )
  );
  const binDir = tempRoot();
  writeExecutable(path.join(binDir, "claude-channel"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false},\"token_path\":\"/tmp/secret-token\"}'",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"list\" ]; then",
    "  echo '{\"targets\":[]}'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  writeExecutable(path.join(binDir, "claude"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":false,\"authMethod\":\"none\",\"apiProvider\":\"firstParty\"}'",
    "  exit 1",
    "fi",
    "exit 1"
  ]);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`
  };
  const start = JSON.parse(
    run(
      cwd,
      ["start", "--name", "codex-thread", "--timeout-ms", "1000", "--poll-ms", "10", "--launch-mode", "background"],
      env
    ).stdout
  );
  assert.equal(start.claude_channel_startup.action, "claude_auth_required");
  assert.equal(start.claude_channel, null);
  assert.equal(JSON.stringify(start).includes(".claude-channel/token"), false);
  assert.equal(JSON.stringify(start).includes("secret-token"), false);
  assert.match(start.claude_channel_startup.auth_help.harness_command, /'channel' 'auth' 'login'/);
});

test("CLI smoke: channel auth guides login and can run the Claude login flow", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const authedFile = path.join(cwd, "authed");
  writeExecutable(path.join(binDir, "claude"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  if [ -f \"$FAKE_AUTHED\" ]; then",
    "    echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"max\"}'",
    "    exit 0",
    "  fi",
    "  echo '{\"loggedIn\":false,\"authMethod\":\"none\",\"apiProvider\":\"firstParty\"}'",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"login\" ]; then",
    "  touch \"$FAKE_AUTHED\"",
    "  echo 'Open https://claude.ai/login to continue'",
    "  exit 0",
    "fi",
    "exit 1"
  ]);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_AUTHED: authedFile
  };
  const status = spawnSync(process.execPath, [cli, "channel", "auth"], {
    cwd,
    env,
    encoding: "utf8"
  });
  assert.equal(status.status, 1);
  const statusJson = JSON.parse(status.stdout);
  assert.equal(statusJson.action, "claude_auth_required");
  assert.match(statusJson.auth_help.harness_command, /'channel' 'auth' 'login'/);
  const login = JSON.parse(run(cwd, ["channel", "auth", "login"], env).stdout);
  assert.equal(login.ok, true);
  assert.equal(login.action, "authenticated");
  assert.match(login.stdout, /https:\/\/claude\.ai\/login/);
});

test("CLI smoke: channel ensure starts a named Claude side through fake binaries", () => {
  const cwd = tempRoot();
  const binDir = tempRoot();
  const readyFile = path.join(cwd, "ready");
  writeExecutable(path.join(binDir, "claude-channel"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then",
    "  if [ -f \"$FAKE_READY\" ]; then",
    "    echo '{\"target\":\"codex-thread\",\"endpoint\":{\"endpoint_id\":\"ep_fake\",\"display_name\":\"codex-thread\"},\"reachable\":true,\"health\":{\"ok\":true}}'",
    "    exit 0",
    "  fi",
    "  echo '{\"reachable\":false,\"health\":{\"ok\":false}}'",
    "  exit 1",
    "fi",
    "exit 1"
  ]);
  writeExecutable(path.join(binDir, "claude"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    "  echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"subscriptionType\":\"max\"}'",
    "  exit 0",
    "fi",
    "touch \"$FAKE_READY\"",
    "echo 'backgrounded - fake123 - codex-thread'",
    "exit 0"
  ]);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_READY: readyFile
  };
  const result = JSON.parse(
    run(
      cwd,
      ["channel", "ensure", "--name", "codex-thread", "--timeout-ms", "1000", "--poll-ms", "10", "--launch-mode", "background"],
      env
    ).stdout
  );
  assert.equal(result.ok, true);
  assert.equal(result.action, "started");
  const start = JSON.parse(run(cwd, ["start", "--name", "codex-thread"], env).stdout);
  assert.equal(start.claude_channel.name, "codex-thread");
});

test("CLI smoke: claim, attempt, review import, verify run, done", () => {
  const cwd = tempRoot();
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput(), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  run(cwd, ["claim", task.task_id, "--owner", "codex"]);
  const attemptFile = path.join(cwd, "attempt.json");
  fs.writeFileSync(
    attemptFile,
    JSON.stringify(
      {
        attempt: 1,
        owner: "codex",
        hypothesis: "Run the narrow backend proof path.",
        changed_files: [],
        commands: ["node --version"],
        result: "passed"
      },
      null,
      2
    )
  );
  run(cwd, ["attempt", task.task_id, "--json", attemptFile]);
  run(cwd, ["review", "request", task.task_id, "--adapter", "mock"]);
  const imported = JSON.parse(run(cwd, ["review", "import", task.task_id]).stdout);
  assert.equal(imported.transition.ok, true);
  assert.equal(imported.transition.task.status, "merge");
  const merged = JSON.parse(run(cwd, ["merge", task.task_id, "--strategy", "serial", "--note", "CLI smoke merge"]).stdout);
  assert.equal(merged.ok, true);
  assert.equal(merged.transition.task.status, "verifying");
  const proof = JSON.parse(run(cwd, ["verify", "run", task.task_id]).stdout);
  assert.equal(proof.manifest.verdict, "pass");
  const done = JSON.parse(run(cwd, ["done", task.task_id]).stdout);
  assert.equal(done.ok, true);
  assert.equal(done.task.status, "done");
  assert.equal(done.leases.released.length, 1);
  assert.equal(done.post_build_refactor_offer.requires_user_confirmation, true);
  assert.match(done.post_build_refactor_offer.recommended_command, /refactor offer/);
  assert.equal(done.post_goal_self_heal_offer.requires_user_confirmation, true);
  assert.match(done.post_goal_self_heal_offer.recommended_command, /self-heal recommend/);
  const final = JSON.parse(run(cwd, ["verify", "final"]).stdout);
  assert.equal(final.ok, true);
  assert.equal(final.post_build_refactor_offer.requires_user_confirmation, true);
  assert.equal(final.post_goal_self_heal_offer.requires_user_confirmation, true);
  const events = JSON.parse(run(cwd, ["events", "--task", task.task_id]).stdout).events;
  assert.ok(events.some((event) => event.type === "lease.claimed"));
  assert.ok(events.some((event) => event.type === "review.requested"));
  assert.ok(events.some((event) => event.type === "review.recorded"));
  assert.ok(events.some((event) => event.type === "merge.recorded"));
  assert.ok(events.some((event) => event.type === "proof.run"));
  assert.ok(events.some((event) => event.type === "task.done"));
  assert.equal(fs.existsSync(path.join(cwd, ".agent-team", "state", "proof", task.task_id, "manifest.json")), true);
});

test("CLI smoke: final check accepts refreshed proof on later final tree", () => {
  const cwd = tempRoot();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });

  function approve(taskId, owner, reviewer) {
    const reviewFile = path.join(cwd, `${taskId}-review.json`);
    fs.writeFileSync(
      reviewFile,
      JSON.stringify(
        {
          reviewer,
          owner,
          verdict: "approve",
          required_fixes: [],
          optional_suggestions: [],
          questions: []
        },
        null,
        2
      )
    );
    run(cwd, ["review", taskId, "--json", reviewFile]);
  }

  function finishTask(input, implementation) {
    const taskFile = path.join(cwd, `${input.title.replace(/\s+/g, "-")}.json`);
    fs.writeFileSync(taskFile, JSON.stringify(input, null, 2));
    const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
    implementation();
    approve(task.task_id, task.owner, task.reviewer);
    run(cwd, ["merge", task.task_id, "--strategy", "serial"]);
    run(cwd, ["verify", "run", task.task_id]);
    run(cwd, ["done", task.task_id]);
    return task;
  }

  const first = finishTask(
    backendTaskInput({
      title: "First task",
      status: "review",
      owner: "claude",
      reviewer: "codex",
      allowed_paths: ["src/ui.js"]
    }),
    () => fs.writeFileSync(path.join(cwd, "src", "ui.js"), "module.exports = 'ui';\n")
  );

  const second = finishTask(
    backendTaskInput({
      title: "Second task",
      status: "review",
      owner: "codex",
      reviewer: "claude",
      allowed_paths: ["src/api.js"]
    }),
    () => fs.writeFileSync(path.join(cwd, "src", "api.js"), "module.exports = 'api';\n")
  );

  const staleResult = spawnSync(process.execPath, [cli, "verify", "final"], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(staleResult.status, 1);
  const stale = JSON.parse(staleResult.stdout);
  assert.equal(stale.ok, false);
  assert.ok(stale.issues.some((issue) => issue === `${first.task_id}: source tree changed since proof run`));

  run(cwd, ["verify", "run", first.task_id]);
  const final = JSON.parse(run(cwd, ["verify", "final"]).stdout);
  assert.equal(final.ok, true);
  assert.ok(final.warnings.some((warning) => warning.includes(`${first.task_id}: proof was refreshed`)));
  assert.equal(final.tasks.done, 2);
  assert.equal(second.task_id, "T-000002");
});

test("CLI smoke: lease conflicts block overlapping exclusive claims", () => {
  const cwd = tempRoot();
  const firstFile = path.join(cwd, "task-1.json");
  const secondFile = path.join(cwd, "task-2.json");
  fs.writeFileSync(firstFile, JSON.stringify(backendTaskInput({ allowed_paths: ["src/api/**"] }), null, 2));
  fs.writeFileSync(
    secondFile,
    JSON.stringify(backendTaskInput({ title: "Nested backend task", allowed_paths: ["src/api/users/**"] }), null, 2)
  );
  const first = JSON.parse(run(cwd, ["tasks", "create", "--json", firstFile]).stdout);
  const second = JSON.parse(run(cwd, ["tasks", "create", "--json", secondFile]).stdout);
  run(cwd, ["claim", first.task_id, "--owner", "codex"]);
  const result = spawnSync(process.execPath, [cli, "claim", second.task_id, "--owner", "codex"], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  const conflict = JSON.parse(result.stdout);
  assert.equal(conflict.lease.action, "lease_conflict");
  assert.equal(conflict.lease.conflicts[0].task_id, first.task_id);
});

test("CLI smoke: task worktree snapshots and merges through Codex final gates", () => {
  const cwd = tempRoot();
  initGitRepo(cwd);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(
    taskFile,
    JSON.stringify(
      backendTaskInput({
        title: "Parallel backend task",
        allowed_paths: ["src/api.js"],
        forbidden_paths: ["src/ui/**"]
      }),
      null,
      2
    )
  );
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const created = JSON.parse(run(cwd, ["worktree", "create", task.task_id]).stdout);
  assert.equal(created.ok, true);
  assert.equal(created.worktree.status, "active");
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, ".agent-team", "state", "tasks", `${task.task_id}.json`), "utf8")).status, "claimed");

  fs.mkdirSync(path.join(created.worktree.worktree_path, "src"), { recursive: true });
  fs.writeFileSync(path.join(created.worktree.worktree_path, "src", "api.js"), "module.exports = 'worktree-api';\n");
  const wtStatus = JSON.parse(run(cwd, ["worktree", "status", task.task_id]).stdout);
  assert.deepEqual(wtStatus.changed_paths, ["src/api.js"]);
  const snapshot = JSON.parse(run(cwd, ["worktree", "snapshot", task.task_id, "--message", "task snapshot"]).stdout);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.worktree.status, "snapshotted");
  assert.match(snapshot.worktree.snapshot_commit, /^[0-9a-f]{40}$/);

  const attemptFile = path.join(cwd, "attempt.json");
  fs.writeFileSync(
    attemptFile,
    JSON.stringify(
      {
        attempt: 1,
        owner: "codex",
        hypothesis: "Implement backend in isolated worktree.",
        changed_files: ["src/api.js"],
        commands: ["node --version"],
        result: "snapshotted"
      },
      null,
      2
    )
  );
  run(cwd, ["attempt", task.task_id, "--json", attemptFile]);
  const reviewFile = path.join(cwd, "review.json");
  fs.writeFileSync(
    reviewFile,
    JSON.stringify(
      {
        reviewer: "claude",
        owner: "codex",
        verdict: "approve",
        required_fixes: [],
        optional_suggestions: [],
        questions: []
      },
      null,
      2
    )
  );
  run(cwd, ["review", task.task_id, "--json", reviewFile]);
  const blocked = spawnSync(process.execPath, [cli, "merge", task.task_id], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /task worktree must be merged/);

  const mergedWorktree = JSON.parse(run(cwd, ["worktree", "merge", task.task_id]).stdout);
  assert.equal(mergedWorktree.ok, true);
  assert.equal(mergedWorktree.worktree.status, "merged");
  assert.equal(fs.readFileSync(path.join(cwd, "src", "api.js"), "utf8"), "module.exports = 'worktree-api';\n");
  const merged = JSON.parse(run(cwd, ["merge", task.task_id, "--strategy", "worktree"]).stdout);
  assert.equal(merged.ok, true);
  assert.equal(merged.merge.worktree.status, "merged");
  run(cwd, ["verify", "run", task.task_id]);
  const done = JSON.parse(run(cwd, ["done", task.task_id]).stdout);
  assert.equal(done.ok, true);
  const final = JSON.parse(run(cwd, ["verify", "final"]).stdout);
  assert.equal(final.ok, true);
  assert.equal(final.worktrees.total, 1);
});

test("CLI smoke: worktree snapshot rejects changes outside task scope", () => {
  const cwd = tempRoot();
  initGitRepo(cwd);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput({ allowed_paths: ["src/api.js"], forbidden_paths: ["src/ui/**"] }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const created = JSON.parse(run(cwd, ["worktree", "create", task.task_id]).stdout);
  fs.mkdirSync(path.join(created.worktree.worktree_path, "src", "ui"), { recursive: true });
  fs.writeFileSync(path.join(created.worktree.worktree_path, "src", "ui", "app.js"), "module.exports = 'ui';\n");
  const result = spawnSync(process.execPath, [cli, "worktree", "snapshot", task.task_id], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.error, "worktree changes outside task path scope");
  assert.deepEqual(parsed.out_of_scope, ["src/ui/app.js"]);
});

test("CLI smoke: SQLite DB indexes lifecycle state and rebuilds from JSON mirrors", () => {
  const cwd = tempRoot();
  initGitRepo(cwd);
  const goal = JSON.parse(run(cwd, ["goal", "new", "--title", "DB backed harness", "--objective", "Index team state"]).stdout);
  run(cwd, ["plan", "codex", "--goal", goal.goal_id, "--text", "Codex owns backend, DB, and proof."]);
  run(cwd, ["plan", "claude", "--goal", goal.goal_id, "--adapter", "mock", "--prompt", "Review DB plan"]);
  run(cwd, ["plan", "import-claude", "--goal", goal.goal_id]);
  run(cwd, ["plan", "reconcile", "--goal", goal.goal_id, "--text", "Use SQLite for query/index and JSON mirrors for recovery."]);

  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(
    taskFile,
    JSON.stringify(
      backendTaskInput({
        goal_id: goal.goal_id,
        title: "DB lifecycle task",
        allowed_paths: ["src/api.js"],
        forbidden_paths: ["src/ui/**"]
      }),
      null,
      2
    )
  );
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const worktree = JSON.parse(run(cwd, ["worktree", "create", task.task_id]).stdout).worktree;
  fs.mkdirSync(path.join(worktree.worktree_path, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktree.worktree_path, "src", "api.js"), "module.exports = 'db-indexed';\n");
  run(cwd, ["worktree", "snapshot", task.task_id, "--message", "db lifecycle snapshot"]);

  const regroundFile = path.join(cwd, "reground.json");
  fs.writeFileSync(
    regroundFile,
    JSON.stringify(
      {
        task_id: task.task_id,
        source: "claude",
        base_tree_hash: "unknown",
        restated_objective: task.objective,
        restated_acceptance: task.acceptance_criteria,
        active_tasks_state: ["Ready for DB indexed lifecycle proof"],
        open_decisions: [],
        divergences_from_files: [],
        corrections: [],
        open_questions: []
      },
      null,
      2
    )
  );
  run(cwd, ["reground", task.task_id, "--json", regroundFile]);

  const moaFile = path.join(cwd, "moa.json");
  fs.writeFileSync(
    moaFile,
    JSON.stringify(
      {
        council_id: "MOA-db-lifecycle",
        scope: "task",
        subject_id: task.task_id,
        kind: "quality",
        question: "Is SQLite advisory only or state authority?",
        participants: [{ agent: "codex" }, { agent: "claude" }],
        synthesis: {
          decision_owner: "codex",
          decision: "SQLite is the query/index database; validated CLI commands still own mutations."
        }
      },
      null,
      2
    )
  );
  run(cwd, ["moa", "record", "--json", moaFile]);

  const attemptFile = path.join(cwd, "attempt.json");
  fs.writeFileSync(
    attemptFile,
    JSON.stringify(
      {
        attempt: 1,
        owner: "codex",
        hypothesis: "SQLite indexes the lifecycle.",
        changed_files: ["src/api.js"],
        commands: ["node --version"],
        result: "snapshotted"
      },
      null,
      2
    )
  );
  run(cwd, ["attempt", task.task_id, "--json", attemptFile]);
  const reviewFile = path.join(cwd, "review.json");
  fs.writeFileSync(
    reviewFile,
    JSON.stringify(
      {
        reviewer: "claude",
        owner: "codex",
        verdict: "approve",
        required_fixes: [],
        optional_suggestions: [],
        questions: []
      },
      null,
      2
    )
  );
  run(cwd, ["review", task.task_id, "--json", reviewFile]);
  run(cwd, ["worktree", "merge", task.task_id]);
  run(cwd, ["merge", task.task_id, "--strategy", "worktree"]);
  run(cwd, ["verify", "run", task.task_id]);
  run(cwd, ["done", task.task_id]);

  const status = JSON.parse(run(cwd, ["db", "status"]).stdout);
  assert.equal(status.ok, true);
  assert.equal(status.counts.goals, 1);
  assert.equal(status.counts.tasks, 1);
  assert.ok(status.counts.events >= 10);
  assert.equal(status.counts.attempts, 1);
  assert.equal(status.counts.reviews, 1);
  assert.equal(status.counts.proof, 1);
  assert.equal(status.counts.leases, 1);
  assert.equal(status.counts.worktrees, 1);
  assert.equal(status.counts.merges, 1);
  assert.equal(status.counts.plans, 3);
  assert.equal(status.counts.regrounds, 1);
  assert.equal(status.counts.advisory, 1);

  fs.appendFileSync(
    path.join(cwd, ".agent-team", "state", "attempts", `${task.task_id}.jsonl`),
    `${JSON.stringify({ task_id: task.task_id, attempt: 1, owner: "codex", result: "duplicate-recovery-row" })}\n`
  );
  const duplicateAttemptStatus = JSON.parse(run(cwd, ["db", "status"]).stdout);
  assert.equal(duplicateAttemptStatus.needs_rebuild, false);
  assert.equal(duplicateAttemptStatus.counts.attempts, 1);
  assert.equal(duplicateAttemptStatus.mirror_counts.attempts, 1);

  const queriedTask = JSON.parse(run(cwd, ["db", "query", "--sql", `select task_id,status,owner from tasks where task_id = '${task.task_id}'`]).stdout);
  assert.deepEqual(queriedTask.rows, [{ task_id: task.task_id, status: "done", owner: "codex" }]);
  const advisoryKinds = JSON.parse(run(cwd, ["db", "query", "--sql", "select kind, count(*) as count from advisory group by kind"]).stdout);
  assert.deepEqual(advisoryKinds.rows, [{ kind: "moa", count: 1 }]);
  const advisoryRow = JSON.parse(run(cwd, ["db", "query", "--sql", "select kind, task_id, goal_id from advisory where kind = 'moa'"]).stdout);
  assert.deepEqual(advisoryRow.rows, [{ kind: "moa", task_id: task.task_id, goal_id: goal.goal_id }]);
  const rejected = spawnSync(process.execPath, [cli, "db", "query", "--sql", "delete from tasks"], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /only allows SELECT/);

  fs.rmSync(path.join(cwd, ".agent-team", "state", "agent-team.sqlite"), { force: true });
  const stale = JSON.parse(run(cwd, ["db", "status"]).stdout);
  assert.equal(stale.needs_rebuild, true);
  assert.equal(stale.counts.tasks, 0);
  assert.equal(stale.mirror_counts.tasks, 1);
  const rebuilt = JSON.parse(run(cwd, ["db", "rebuild"]).stdout);
  assert.deepEqual(rebuilt.counts, status.counts);
  const clean = JSON.parse(run(cwd, ["db", "status"]).stdout);
  assert.equal(clean.needs_rebuild, false);
  assert.deepEqual(clean.counts, status.counts);
  const queriedProof = JSON.parse(run(cwd, ["db", "query", "--sql", `select task_id,verdict from proof where task_id = '${task.task_id}'`]).stdout);
  assert.deepEqual(queriedProof.rows, [{ task_id: task.task_id, verdict: "pass" }]);
  const rebuiltAdvisoryRow = JSON.parse(run(cwd, ["db", "query", "--sql", "select kind, task_id, goal_id from advisory where kind = 'moa'"]).stdout);
  assert.deepEqual(rebuiltAdvisoryRow.rows, advisoryRow.rows);
});

test("CLI smoke: failed worktree creation rolls back ready claim and lease", () => {
  const cwd = tempRoot();
  initGitRepo(cwd);
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput({ allowed_paths: ["src/api.js"] }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const blockingPath = path.join(cwd, "not-a-directory");
  fs.writeFileSync(blockingPath, "existing file\n");
  const result = spawnSync(process.execPath, [cli, "worktree", "create", task.task_id, "--path", blockingPath], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.action, "worktree_add_failed");
  assert.equal(parsed.rollback.status, "ready");
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, ".agent-team", "state", "tasks", `${task.task_id}.json`), "utf8")).status, "ready");
  const leases = JSON.parse(run(cwd, ["lease", "list"]).stdout).leases;
  assert.equal(leases.filter((lease) => lease.task_id === task.task_id && lease.status === "active").length, 0);
});

test("CLI smoke: MoA records advisory-only Codex-owned decisions", () => {
  const cwd = tempRoot();
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput(), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const moaFile = path.join(cwd, "moa.json");
  fs.writeFileSync(
    moaFile,
    JSON.stringify(
      {
        council_id: "MOA-test",
        scope: "task",
        subject_id: task.task_id,
        kind: "architecture",
        question: "Should this task use a worktree?",
        participants: [
          {
            agent: "codex",
            verdict: "yes",
            rationale: "It isolates backend changes."
          },
          {
            agent: "claude",
            verdict: "yes",
            rationale: "It keeps UI review separate."
          }
        ],
        synthesis: {
          decision_owner: "codex",
          decision: "Use a worktree, then verify final tree.",
          accepted: ["isolation"],
          rejected: ["MoA as owner"]
        }
      },
      null,
      2
    )
  );
  const council = JSON.parse(run(cwd, ["moa", "record", "--json", moaFile]).stdout);
  assert.equal(council.advisory_only, true);
  assert.equal(council.synthesis.decision_owner, "codex");
  const after = JSON.parse(fs.readFileSync(path.join(cwd, ".agent-team", "state", "tasks", `${task.task_id}.json`), "utf8"));
  assert.equal(after.status, "ready");
  const list = JSON.parse(run(cwd, ["moa", "list", "--scope", "task", "--subject", task.task_id]).stdout);
  assert.equal(list.councils.length, 1);
  const shown = JSON.parse(run(cwd, ["moa", "show", "MOA-test"]).stdout);
  assert.equal(shown.council.council_id, "MOA-test");

  fs.writeFileSync(
    moaFile,
    JSON.stringify(
      {
        scope: "task",
        subject_id: task.task_id,
        question: "Who decides?",
        participants: [{ agent: "codex" }, { agent: "claude" }],
        synthesis: { decision_owner: "claude" }
      },
      null,
      2
    )
  );
  const rejected = spawnSync(process.execPath, [cli, "moa", "record", "--json", moaFile], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /moa decision_owner must be codex/);
});

test("CLI smoke: Claude Agent Teams imports are frontend accelerators only", () => {
  const cwd = tempRoot();
  const taskFile = path.join(cwd, "frontend-task.json");
  fs.writeFileSync(taskFile, JSON.stringify(frontendTaskInput(), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const importFile = path.join(cwd, "agent-teams.json");
  fs.writeFileSync(
    importFile,
    JSON.stringify(
      {
        import_id: "AT-test",
        task_id: task.task_id,
        subagents: [
          { name: "claude-ui-builder", role: "layout" },
          { name: "claude-visual-reviewer", role: "visual_qa" }
        ],
        summary: "Claude Agent Teams split layout and visual QA.",
        changed_paths: ["src/ui/settings.tsx"],
        recommendations: ["Keep Codex as proof owner."]
      },
      null,
      2
    )
  );
  const imported = JSON.parse(run(cwd, ["agent-teams", "import", "--json", importFile]).stdout);
  assert.equal(imported.import_id, "AT-test");
  assert.equal(imported.advisory_only, true);
  assert.equal(imported.codex_state_authority, true);
  const after = JSON.parse(fs.readFileSync(path.join(cwd, ".agent-team", "state", "tasks", `${task.task_id}.json`), "utf8"));
  assert.equal(after.status, "ready");
  const list = JSON.parse(run(cwd, ["agent-teams", "list", "--task", task.task_id]).stdout);
  assert.equal(list.imports.length, 1);
  const shown = JSON.parse(run(cwd, ["agent-teams", "show", "AT-test"]).stdout);
  assert.equal(shown.import.import_id, "AT-test");
  const cockpit = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(cockpit.agent_teams.total, 1);
  const cockpitText = run(cwd, ["cockpit", "--no-live-channel"]).stdout;
  assert.match(cockpitText, /Claude Agent Teams/);
  assert.match(cockpitText, /AT-test/);
  assert.match(cockpitText, /authority=codex/);

  fs.writeFileSync(
    importFile,
    JSON.stringify(
      {
        task_id: task.task_id,
        subagents: ["claude-ui-builder"],
        changed_paths: ["src/api/not-frontend.ts"],
        summary: "Wrong path."
      },
      null,
      2
    )
  );
  const outOfScope = spawnSync(process.execPath, [cli, "agent-teams", "import", "--json", importFile], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(outOfScope.status, 1);
  assert.match(outOfScope.stderr, /outside task scope/);

  fs.writeFileSync(
    importFile,
    JSON.stringify(
      {
        task_id: task.task_id,
        subagents: ["claude-ui-builder"],
        changed_paths: ["src/ui/../api/not-frontend.ts"],
        summary: "Traversal path."
      },
      null,
      2
    )
  );
  const traversal = spawnSync(process.execPath, [cli, "agent-teams", "import", "--json", importFile], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(traversal.status, 1);
  assert.match(traversal.stderr, /path traversal/);

  for (const [changedPath, expectedError] of [
    ["/tmp/not-frontend.ts", /relative path/],
    ["C:/tmp/not-frontend.ts", /relative path/],
    ["src\\ui\\..\\api\\not-frontend.ts", /path traversal/]
  ]) {
    fs.writeFileSync(
      importFile,
      JSON.stringify(
        {
          task_id: task.task_id,
          subagents: ["claude-ui-builder"],
          changed_paths: [changedPath],
          summary: "Invalid path."
        },
        null,
        2
      )
    );
    const invalidPath = spawnSync(process.execPath, [cli, "agent-teams", "import", "--json", importFile], {
      cwd,
      encoding: "utf8"
    });
    assert.equal(invalidPath.status, 1);
    assert.match(invalidPath.stderr, expectedError);
  }

  fs.writeFileSync(
    importFile,
    JSON.stringify(
      {
        task_id: task.task_id,
        subagents: [],
        summary: "Empty subagent list."
      },
      null,
      2
    )
  );
  const emptySubagents = spawnSync(process.execPath, [cli, "agent-teams", "import", "--json", importFile], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(emptySubagents.status, 1);
  assert.match(emptySubagents.stderr, /requires at least one subagent/);

  const backendFile = path.join(cwd, "backend-task.json");
  fs.writeFileSync(backendFile, JSON.stringify(backendTaskInput({ title: "Backend cannot use Agent Teams" }), null, 2));
  const backend = JSON.parse(run(cwd, ["tasks", "create", "--json", backendFile]).stdout);
  fs.writeFileSync(
    importFile,
    JSON.stringify(
      {
        task_id: backend.task_id,
        subagents: ["claude-ui-builder"],
        summary: "Wrong lane."
      },
      null,
      2
    )
  );
  const rejected = spawnSync(process.execPath, [cli, "agent-teams", "import", "--json", importFile], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /limited to Claude-owned frontend tasks/);
});

test("CLI smoke: Codex subagents import task-scoped advisory execution evidence", () => {
  const cwd = tempRoot();
  const taskFile = path.join(cwd, "backend-task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput(), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const importFile = path.join(cwd, "codex-subagents.json");
  fs.writeFileSync(
    importFile,
    JSON.stringify(
      {
        import_id: "CS-test",
        task_id: task.task_id,
        subagents: [
          { name: "codex-explore", role: "repo_map", status: "complete", outputs: ["src/api/router.js"] },
          { name: "codex-verifier", role: "test_probe", status: "complete" }
        ],
        summary: "Codex native subagents mapped backend scope and checked proof prep.",
        changed_paths: ["src/api/router.js"],
        outputs: ["repo map", "test probe"],
        recommendations: ["Keep task owner unchanged."]
      },
      null,
      2
    )
  );
  const imported = JSON.parse(run(cwd, ["codex-subagents", "import", "--json", importFile]).stdout);
  assert.equal(imported.import_id, "CS-test");
  assert.equal(imported.advisory_only, true);
  assert.equal(imported.execution_evidence, true);
  assert.equal(imported.codex_state_authority, true);
  assert.equal(imported.task_owner, "codex");
  const after = JSON.parse(fs.readFileSync(path.join(cwd, ".agent-team", "state", "tasks", `${task.task_id}.json`), "utf8"));
  assert.equal(after.status, "ready");
  assert.equal(after.owner, "codex");
  const list = JSON.parse(run(cwd, ["codex-subagents", "list", "--task", task.task_id]).stdout);
  assert.equal(list.imports.length, 1);
  const shown = JSON.parse(run(cwd, ["codex-subagents", "show", "CS-test"]).stdout);
  assert.equal(shown.import.import_id, "CS-test");
  assert.equal(fs.existsSync(path.join(cwd, ".agent-team", "state", "advisory", "codex-subagents", "CS-test.json")), true);
  const advisoryRow = JSON.parse(run(cwd, ["db", "query", "--sql", "select kind, task_id, goal_id from advisory where kind = 'codex-subagents'"]).stdout);
  assert.deepEqual(advisoryRow.rows, [{ kind: "codex-subagents", task_id: task.task_id, goal_id: task.goal_id }]);
  const events = JSON.parse(run(cwd, ["events", "--task", task.task_id, "--type", "codex_subagents.imported"]).stdout).events;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].detail.subagents, ["codex-explore", "codex-verifier"]);
  const cockpit = JSON.parse(run(cwd, ["cockpit", "--json", "--no-live-channel"]).stdout);
  assert.equal(cockpit.codex_subagents.total, 1);
  assert.equal(cockpit.codex_subagents.recent[0].import_id, "CS-test");
  assert.equal(cockpit.codex_subagents.recent[0].task_owner, "codex");
  assert.equal(cockpit.codex_subagents.recent[0].facet, "backend_api");
  assert.equal(cockpit.codex_subagents.recent[0].execution_evidence, true);
  const cockpitText = run(cwd, ["cockpit", "--no-live-channel"]).stdout;
  assert.match(cockpitText, /Codex Subagents/);
  assert.match(cockpitText, /CS-test/);
  assert.match(cockpitText, /owner=codex/);
  assert.match(cockpitText, /evidence=true/);

  fs.writeFileSync(
    importFile,
    JSON.stringify(
      {
        task_id: task.task_id,
        subagents: ["codex-explore"],
        changed_paths: ["src/ui/settings.tsx"],
        summary: "Wrong path."
      },
      null,
      2
    )
  );
  const outOfScope = spawnSync(process.execPath, [cli, "codex-subagents", "import", "--json", importFile], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(outOfScope.status, 1);
  assert.match(outOfScope.stderr, /outside task scope/);

  fs.writeFileSync(
    importFile,
    JSON.stringify(
      {
        task_id: task.task_id,
        subagents: ["codex-explore"],
        changed_paths: ["src/api/../ui/settings.tsx"],
        summary: "Traversal path."
      },
      null,
      2
    )
  );
  const traversal = spawnSync(process.execPath, [cli, "codex-subagents", "import", "--json", importFile], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(traversal.status, 1);
  assert.match(traversal.stderr, /path traversal/);

  for (const [changedPath, expectedError] of [
    ["/tmp/router.js", /relative path/],
    ["C:/tmp/router.js", /relative path/],
    ["src\\api\\..\\ui\\settings.tsx", /path traversal/]
  ]) {
    fs.writeFileSync(
      importFile,
      JSON.stringify(
        {
          task_id: task.task_id,
          subagents: ["codex-explore"],
          changed_paths: [changedPath],
          summary: "Invalid path."
        },
        null,
        2
      )
    );
    const invalidPath = spawnSync(process.execPath, [cli, "codex-subagents", "import", "--json", importFile], {
      cwd,
      encoding: "utf8"
    });
    assert.equal(invalidPath.status, 1);
    assert.match(invalidPath.stderr, expectedError);
  }

  fs.writeFileSync(
    importFile,
    JSON.stringify(
      {
        task_id: task.task_id,
        subagents: [],
        summary: "Empty subagent list."
      },
      null,
      2
    )
  );
  const emptySubagents = spawnSync(process.execPath, [cli, "codex-subagents", "import", "--json", importFile], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(emptySubagents.status, 1);
  assert.match(emptySubagents.stderr, /requires at least one subagent/);

  fs.writeFileSync(
    importFile,
    JSON.stringify(
      {
        task_id: task.task_id,
        subagents: ["codex-explore"],
        advisory_only: false,
        summary: "Tries to become authoritative."
      },
      null,
      2
    )
  );
  const nonAdvisory = spawnSync(process.execPath, [cli, "codex-subagents", "import", "--json", importFile], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(nonAdvisory.status, 1);
  assert.match(nonAdvisory.stderr, /must be advisory_only/);
});

test("CLI smoke: quality block_merge advisory prevents merge until cleared", () => {
  const cwd = tempRoot();
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify(backendTaskInput({ status: "review" }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const reviewFile = path.join(cwd, "review.json");
  fs.writeFileSync(
    reviewFile,
    JSON.stringify(
      {
        reviewer: "claude",
        owner: "codex",
        verdict: "approve",
        required_fixes: [],
        optional_suggestions: [],
        questions: []
      },
      null,
      2
    )
  );
  run(cwd, ["review", task.task_id, "--json", reviewFile]);
  const qualityFile = path.join(cwd, "quality.json");
  fs.writeFileSync(
    qualityFile,
    JSON.stringify(
      {
        verdict: "block_merge",
        findings: [{ file: "src/api/users.js", issue: "Deletes validation", severity: "P1" }],
        rationale: "Structural regression, not taste."
      },
      null,
      2
    )
  );
  run(cwd, ["quality", task.task_id, "--json", qualityFile]);
  const blocked = spawnSync(process.execPath, [cli, "merge", task.task_id], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /quality gate blocks merge/);
  fs.writeFileSync(
    qualityFile,
    JSON.stringify(
      {
        verdict: "pass",
        findings: [],
        rationale: "Validation restored."
      },
      null,
      2
    )
  );
  run(cwd, ["quality", task.task_id, "--json", qualityFile]);
  const merged = JSON.parse(run(cwd, ["merge", task.task_id]).stdout);
  assert.equal(merged.ok, true);
});

test("CLI smoke: fake browser proof artifacts feed verify run for frontend task", () => {
  const cwd = tempRoot();
  const html = path.join(cwd, "index.html");
  fs.writeFileSync(html, "<!doctype html><title>Harness</title><button>Save</button>\n");
  const taskFile = path.join(cwd, "frontend-task.json");
  fs.writeFileSync(taskFile, JSON.stringify(frontendTaskInput({ status: "review" }), null, 2));
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const reviewFile = path.join(cwd, "review.json");
  fs.writeFileSync(
    reviewFile,
    JSON.stringify(
      {
        reviewer: "codex",
        owner: "claude",
        verdict: "approve",
        required_fixes: [],
        optional_suggestions: [],
        questions: []
      },
      null,
      2
    )
  );
  const reviewed = JSON.parse(run(cwd, ["review", task.task_id, "--json", reviewFile]).stdout);
  assert.equal(reviewed.transition.task.status, "merge");
  run(cwd, ["merge", task.task_id]);
  const proofEnv = { ...process.env, AGENT_TEAM_FAKE_BROWSER_PROOF: "1" };
  const browser = JSON.parse(
    run(cwd, ["verify", "browser", task.task_id, "--url", "index.html", "--viewport", "390x844", "--run-id", "fake-mobile"], proofEnv).stdout
  );
  assert.equal(browser.ok, true);
  assert.equal(fs.existsSync(path.join(cwd, browser.artifacts.screenshot)), true);
  const proof = JSON.parse(
    run(cwd, [
      "verify",
      "run",
      task.task_id,
      "--browser-run",
      browser.artifacts.browser_run,
      "--screenshot",
      browser.artifacts.screenshot,
      "--console-check",
      browser.artifacts.console_check
    ]).stdout
  );
  assert.equal(proof.ok, true);
  const done = JSON.parse(run(cwd, ["done", task.task_id]).stdout);
  assert.equal(done.ok, true);
});

test("CLI smoke: computer-use proof is required when task declares desktop interaction", () => {
  const cwd = tempRoot();
  const taskFile = path.join(cwd, "desktop-task.json");
  fs.writeFileSync(
    taskFile,
    JSON.stringify(
      backendTaskInput({
        status: "review",
        proof: {
          commands: ["node --version"],
          requires_browser: false,
          requires_screenshot: false,
          requires_computer: true
        }
      }),
      null,
      2
    )
  );
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const reviewFile = path.join(cwd, "review.json");
  fs.writeFileSync(
    reviewFile,
    JSON.stringify(
      {
        reviewer: "claude",
        owner: "codex",
        verdict: "approve",
        required_fixes: [],
        optional_suggestions: [],
        questions: []
      },
      null,
      2
    )
  );
  const reviewed = JSON.parse(run(cwd, ["review", task.task_id, "--json", reviewFile]).stdout);
  assert.equal(reviewed.transition.task.status, "merge");
  run(cwd, ["merge", task.task_id]);
  const missingComputer = JSON.parse(run(cwd, ["verify", "run", task.task_id]).stdout);
  assert.equal(missingComputer.ok, true);
  const blockedDone = spawnSync(process.execPath, [cli, "done", task.task_id], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(blockedDone.status, 1);
  assert.match(blockedDone.stdout, /computer-use artifact or waiver is required/);

  const computer = JSON.parse(
    run(cwd, ["verify", "computer", task.task_id, "--fake", "--app", "Codex Desktop", "--interaction", "desktop smoke", "--run-id", "fake-desktop"]).stdout
  );
  assert.equal(computer.ok, true);
  assert.equal(fs.existsSync(path.join(cwd, computer.artifacts.computer_run)), true);
  const proof = JSON.parse(run(cwd, ["verify", "run", task.task_id, "--computer-run", computer.artifacts.computer_run]).stdout);
  assert.equal(proof.ok, true);
  const done = JSON.parse(run(cwd, ["done", task.task_id]).stdout);
  assert.equal(done.ok, true);
});

test("CLI smoke: verify run exits nonzero and saves failing manifest", () => {
  const cwd = tempRoot();
  const taskFile = path.join(cwd, "task.json");
  fs.writeFileSync(
    taskFile,
    JSON.stringify(
      backendTaskInput({
        proof: {
          commands: ["node -e \"process.exit(7)\""],
          requires_browser: false,
          requires_screenshot: false
        }
      }),
      null,
      2
    )
  );
  const task = JSON.parse(run(cwd, ["tasks", "create", "--json", taskFile]).stdout);
  const result = spawnSync(process.execPath, [cli, "verify", "run", task.task_id], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.ok, false);
  assert.equal(proof.manifest.verdict, "fail");
  assert.equal(proof.manifest.commands[0].exit_code, 7);
  assert.equal(fs.existsSync(path.join(cwd, ".agent-team", "state", "proof", task.task_id, "manifest.json")), true);
});
