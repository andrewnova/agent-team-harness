---
name: agent-team-harness
description: Operate the local Agent Team Harness for Codex-led Claude/Codex teammate workflows. Use when planning, routing, executing, reviewing, handing off, re-grounding, or verifying work through the `agent-team` CLI; when Claude should own frontend/UI/UX work; when Codex should own backend/proof/e2e work; or when `.agent-team` state, proof gates, channel asks, task boards, or cross-model review records are involved.
---

# Agent Team Harness

Use the local CLI as the source of truth. Do not treat chat, generated markdown projections, or model confidence as completion evidence.

Use one normal operator CLI: `agent-team`. The local Claude channel bridge is a transport dependency below it, not a second workflow the user should operate during ordinary harness runs. Raw channel commands are diagnostic escape hatches only.

Hard transport rule: do not use raw `ask_claude`, raw live-channel asks, or `complete_channel_request` as the delegation path for planning, implementation, frontend work, review, refactor, or debugging tasks. Those synchronous channel paths are only for health checks, smoke tests, and low-level bridge diagnostics. Real work for Claude must be represented in harness state and delivered through mailbox-backed CLI flows so Codex can keep working while Claude is busy.

Visible-Claude rule: for Claude-owned tasks, especially frontend/UI/UX work, Codex must start or attach a visible Claude Code teammate and deliver steering through `channel steer` with live delivery enabled by default. The user should be able to see Claude receive Codex's steering unless the user explicitly asks for quiet/mailbox-only mode. Do not use `--no-live`, mailbox-only delegation, background-only launch, or hidden/PTY launch for Claude-owned work unless the user explicitly requested that mode. If visible attach/start or live delivery fails, treat that as a blocking harness setup problem for the Claude-owned task: run the repair/auth/endpoint diagnostics, report the exact blocker, and do not claim Claude is working or mark the task delegated until a visible Claude channel is healthy or the user explicitly overrides the visible requirement.

The daemon exists to connect Codex and Claude through the durable mailbox: receipt ACKs, semantic ACKs, check-ins, replies, cockpit visibility, importable state, visible Claude wake-ups, and Codex wake payloads. If Claude should do work, use a mailbox-first command such as `plan claude` with the default adapter, `review request`, `channel steer`, or `mailbox send --to claude --kind request --reply-required`; ordinary Codex-to-Claude `notify`/`checkin` traffic should still be written to the mailbox first, queued to `.agent-team/comms/claude-mcp/outbox.jsonl` for the first-party Claude MCP channel server, and live-woken by the legacy channel fallback when available. For Claude-owned tasks, pair that durable request with the visible-Claude rule above. For Claude-to-Codex messages, the daemon must queue `.agent-team/comms/codex-wake/` payloads and invoke the first available Codex wake adapter: explicit `AGENT_TEAM_CODEX_WAKE_COMMAND` first, then the installed `agent-team-codex-wake` command recorded by `agent-team codex mcp install`. The first-party `agent-team-codex-mcp` adapter is the Codex-side reader/reply surface for that stream: `agent-team codex mcp install`, `agent_team_codex_watch_mailbox`, ACK, reply, and task-open tools. Then keep Codex moving and later import or acknowledge Claude's mailbox reply.

## Invocation Behavior

When this skill is invoked, Codex operates the harness. Do not tell the user to run the harness manually unless they ask for raw commands.

1. Choose a short session name that matches the Codex thread/project name when available; otherwise use a stable project name such as `codex-agent-team-harness`.
   - If no `--name` is supplied, the harness derives a default from the project plus `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, or `AGENT_TEAM_SESSION_ID` when present. That is the preferred default for same-Codex-thread resume and new-Codex-thread separation. Use an explicit `--name` only when the user wants a shared project-level Claude teammate.
2. If the Claude bridge is missing or stale, run `node agent-team/src/cli.js doctor --fix --target <session-name>` before startup. `doctor --fix` installs the harness-managed `claude-channel-cli` package, writes local wrappers, and attempts user-scope MCP setup; it is the supported repair path, not a separate user workflow.
3. Run `node agent-team/src/cli.js start --name <session-name> --daemon` unless the user explicitly disables the Claude connection or asks for deterministic/offline mode. If the desired Claude workspace is not the harness repo root, pass `--project-dir <project-root>`; for a clean new teammate, add `--fresh-claude`. `start --daemon` invokes Claude channel ensure, first prefers the remembered endpoint id from `.agent-team/comms/claude-channel/session.json` when the same Codex-thread `session_identity.thread_ref` and `project_dir` match, then falls back to reachable same-project endpoint labels, launches a visible Claude Code teammate in a separate Terminal window, and verifies or starts the hidden mailbox receiver daemon so Codex can keep working while Claude responds. Display names are labels/fallbacks, not primary identity. `--fresh-claude` bypasses remembered reuse and must produce a genuinely new same-project endpoint; when it does not, inspect `fresh_start_no_new_endpoint`, `discovered.probe`, and `fresh_launch_probe` instead of treating the launch as delegated. A same-name endpoint from another `project_dir` is reported as `workspace_mismatch` unless `--allow-cross-project-reuse` is explicitly passed. Codex Desktop's built-in Terminal can be opened manually, and Codex can read terminal output once a terminal is attached, but the exposed Codex tool surface does not provide a native open/write-terminal API. Do not rely on AppleScript or coordinate automation as the default. If the user explicitly asks for Codex Terminal with `--launch-mode codex-terminal`, require `AGENT_TEAM_CODEX_TERMINAL_LAUNCHER` or `--codex-terminal-launcher <path>`, report launcher failure honestly, and do not silently fall back. Failed Claude startup blocks `start` by default; use `--allow-degraded-claude` only for diagnostics or intentionally Codex-only work. Use `--no-ensure-claude` only for offline/deterministic runs, `--no-daemon` only for tests or diagnostics, `--launch-mode pty` for hidden receiver fallback, and `--launch-mode background` only for diagnostics/CI. Use approved channel mode only when the local channel bridge is allowlisted. Add `--smoke` when the next step requires a live Claude reply now, and treat a failed smoke as a real readiness failure.
4. Inspect the returned `claude_channel_startup` field before assuming Claude is available.
5. Inspect `node agent-team/src/cli.js config` when you need to confirm turbo parallel policy. Default should be `execution_profile: turbo_parallel`.
6. Run `node agent-team/src/cli.js daemon status` and `node agent-team/src/cli.js watch --once --no-live-channel` for a quick local cockpit snapshot, or `node agent-team/src/cli.js watch --target <session-name>` when live Claude status should be checked continuously. The cockpit scans receiver daemon health, realtime mailbox messages, pending receipt ACKs, pending semantic ACK/reply requirements, Claude steering notices, Claude check-ins, Codex MCP adapter status, Codex wake stream state, Claude startup identity/probe state (`Claude startup:`), and the per-message timeline (`mailbox_sent -> ... -> mailbox_reply`) before surfacing Next Actions.
7. If the user's desired mode is not already obvious, ask exactly one short question: "Planning Mode or Dev Mode?"
8. Recommend Planning Mode for a new project, unclear scope, architecture decisions, or when Codex and Claude should both shape the plan first.
9. Recommend Dev Mode when canonical tasks already exist, the user explicitly wants execution, or there is a concrete bug/fix to run through claim, attempt, review, proof, and done gates.
10. After the user chooses, operate the CLI yourself and keep the user steering from Codex.

## Start Here

Run commands from the harness root:

```bash
node agent-team/src/cli.js <command>
```

Read `README.md`, the relevant source files, and the current tests before changing schemas, state transitions, proof policy, routing rules, bridge behavior, or acceptance tests.

## State Storage

Harness state is SQLite plus JSON mirrors. Treat SQLite as the inspection/recovery surface and the JSON files as durable, reviewable mirrors for agents and humans.

Use the DB commands for state inspection and repair:

```bash
node agent-team/src/cli.js db status
node agent-team/src/cli.js db rebuild
node agent-team/src/cli.js db query --sql "select * from tasks limit 5"
```

Rules:

- Use `db status` before assuming state corruption.
- Use `db rebuild` to recover SQLite from JSON mirrors.
- Use `db query` for read-only inspection and debugging.
- Do not mutate SQLite, JSON mirrors, or task state directly; all mutations still go through validated CLI commands such as `tasks create`, `claim`, `attempt`, `review import`, `merge`, `verify run`, and `done`.
- Codex remains the proof and final-state owner even when Claude, Agent Teams, MoA, or DB recovery commands contribute evidence.

## Planning Mode

1. Initialize state with `node agent-team/src/cli.js init`.
2. Create or load a goal with `goal new`.
3. Record Codex's planning proposal with `plan codex --goal <goal> --text <plan>` or `--file <file>`.
4. Ask Claude for plan critique with `plan claude`.
   - Use the default `--adapter mailbox` for normal planning so Codex does not block while Claude thinks.
   - Use `--adapter claude-channel --target <name> --timeout-ms <ms>` only when a synchronous reply-required smoke/proof ask is explicitly needed.
   - Do not bypass this with raw `ask_claude`; that skips the daemon, mailbox, ACK, cockpit, and import path.
   - Use `--adapter mock` only for deterministic local tests.
   - Use `--adapter manual` only when live Claude is unavailable.
5. Import an answered Claude response with `plan import-claude --goal <goal> [--request-id <id>]`.
6. Reconcile the final plan with `plan reconcile --goal <goal> --text <plan>` or `--file <file>`.
7. Convert the reconciled plan into canonical task JSON. Split mixed work by facet.
8. Run `tasks create --json <file>` for each task.
9. Run `promote-dev` only after Codex and Claude planning input is recorded, or after a degraded-planning reason is explicitly recorded.

## Routing Rules

Route by task facet:

- Claude owns frontend UI, UX/layout, copy polish, visual QA, and frontend browser observation/debugging.
- When delegating any Claude-owned task, Codex must first make the live Claude teammate visible to the user with the correct project root. Use `start --name <session> --project-dir <project-root> --daemon` or `channel ensure --name <session> --project-dir <project-root> --launch-mode visible` before steering. If no matching visible endpoint is available or live delivery fails, block Claude-owned task execution and fix the endpoint/auth/session problem; do not silently fall back to mailbox-only, do not send `--no-live`, and do not say Claude is working unless the user explicitly overrides visible mode.
- Codex owns backend, data model, state machine, test/proof harness, browser/computer-use proof, merge, and final `done`.
- Codex should use max useful native subagents for independent backend, tests, docs, review, debugging, and proof-prep slices. Import their results with `codex-subagents import` when the evidence matters.
- Claude may use available browser observation tools for frontend debugging when permitted by the local environment.
- Claude Agent Teams should accelerate Claude-owned frontend subwork, but import the result with `agent-teams import` and keep Codex as state/proof authority.
- Codex remains proof authority even when Claude implements the UI.
- If a task changes owner, use `claim <task> --owner <owner> --reason <reason>` so RT-1 owner history is preserved.
- Use the hidden receiver daemon plus realtime mailbox as the always-on teammate lane in both directions. Codex and Claude can run `mailbox send --from <role> --to <role> --kind checkin|heartbeat|notify|reply|receipt_ack` at any time, especially while waiting on Agent Teams/subagents. Claude-to-Codex non-heartbeat traffic should also create a Codex wake payload so the Codex side can notice it immediately when a local wake adapter exists.
- Do not delegate work to Claude through raw `ask_claude`. The raw live channel can prove reachability, but it is not the harness work bus and it is not the teammate coordination layer.
- Use `mailbox send-batch --json <file>` for two or more mailbox replies, review verdicts, check-ins, or recommendations. Run it with an absolute CLI path plus `--cwd <harness-root>` when the sender is inside a temporary job directory. Do not hand-roll shell loops, relative `cli.js` calls, `head` parsing, or `$C` subshell variables for multi-message delivery.
- Low-level mailbox ACK only means delivery/read state. Daemon-generated `receipt_ack` messages mean the receiving inbox saw the message quickly; they do not answer the message and they are not long-task check-ins or completion proof.
- Requests, `reply_required` messages, and explicit `semantic_ack_required` messages must receive a semantic mailbox `reply` from the receiving model that acknowledges the content, states what it will do next, and answers the question or names the blocker. Non-required `notify`, `checkin`, and human-relevant `reply` messages must still surface in cockpit/watch until read or acked, but they are advisory and do not block tasks.
- Cockpit/channel pending queues treat mailbox `reply` messages keyed by `request_id` or `in_reply_to` as answered. If Claude says it already sent a reply, inspect/import mailbox replies before nudging again.
- `review import`, `plan import-claude`, and `reground import` should consume the actual mailbox body (`body_inline`, `body_path`, `answer`, `text`, `stdout`, `body`, or `payload`), not wrapper metadata. If import fails while the body is present, record a self-heal recommendation before using manual recovery.
- `timeout_pending` is a live-channel waiter state, not proof that Claude stopped working, that the waiter expired, or that a mailbox reply is lost. Mailbox replies/check-ins are authoritative and should be inspected before nudging Claude again.
- Completed-task mailbox/live-channel leftovers are audit records, not active work. Cockpit should report them as completed-stale instead of prompting fresh nudges.
- For critical Claude-owned steering, use `channel steer` instead of a raw live ask. It queues a reply-required Codex-to-Claude mailbox request first, then optionally attempts live-channel delivery. Treat the returned `durable_ack.mailbox_message_id` as the ACK handle even if the live channel times out or fails.
- If Claude leaves a steering notice, Codex must read it before continuing related work. Use `notice scan --project-dir <project-root>`, `notice list --status new`, `notice show <notice-id>`, then `notice ack <notice-id> --status acknowledged|applied|rejected --note <text>`. Notices are advisory steering records, not automatic task mutations.
- If Claude sends a structured check-in, Codex must read pending steering before continuing related work. Use `checkin list --from claude --ack-status new`, `checkin show <checkin-id>`, then `checkin ack <checkin-id> --status acknowledged|applied|rejected --note <text>`. Check-ins are advisory steering records, not automatic task mutations.
- Every task created through `tasks create` carries a durable `goal_prompt`. Preserve it in handoffs and do not strip it during refactors.

## Dev Mode

For each task:

1. Claim it with `claim <task> --owner <codex|claude> --reason <reason>` if ownership changes.
2. Record every implementation attempt with `attempt <task> --json <file>`.
3. Request cross-model review with `review request <task>` using the default nonblocking mailbox adapter. Use `--adapter claude-channel --target <name>` only for explicit synchronous proof/smoke asks; use `--adapter mock` only for tests and `manual` only for degraded operation.
   - If Claude owns implementation work, send the task as a reply-required mailbox request or `channel steer`; do not use raw `ask_claude`.
4. Import the answered review with `review import <task> [--request-id <id>]`. Approval/waiver moves the task to `merge`; `changes_requested` or `block_merge` keeps the task in review.
5. Run optional harsh structural review with `quality <task> --json <file>` when the diff is risky. Only `verdict: "block_merge"` blocks the merge gate.
6. If the task used an isolated worktree, run `worktree merge <task>` before the final tree record.
7. Record the final tree with `merge <task>`. This moves the task to `verifying`.
8. For frontend/browser-visible work, run `verify browser <task> --url <url>` to create browser-run, screenshot, console-check, and browser-findings artifacts under `.agent-team/evidence/`. `verify run` may source-safely reattach the newest matching browser artifacts when the current source digest matches the browser run.
9. For desktop/app/window work, run `verify computer <task> --artifact <path>` after Codex computer-use observation and pass the returned `--computer-run` artifact to `verify run`.
10. Run deterministic proof with `verify run <task>`, adding browser/screenshot/console/computer artifacts from `verify browser`/`verify computer` or explicit waivers when required. Use `verify <task> --json <file>` only when importing externally collected proof.
11. Run `done <task>` only after the task is in `verifying`, review is approved or waived, the merge record exists, required command results pass, and required browser/screenshot/console/computer artifacts or waivers exist.
12. Run `verify final` before claiming the project/workstream is complete.
13. Run `closeout [--goal <goal>]` for project closeout. It runs final verification, reports mailbox truth and daemon status, and writes `.agent-team/reports/<goal>/GOAL_REPORT.md`; use `--stop-daemon` only when ending the teammate session on purpose.
14. Run `goal report --goal <goal>` to regenerate the report without stopping anything, and `retention policy --goal <goal>` to write explicit compaction/retention rules without deleting evidence.
15. Run `port check --port <port> --next` before local web proof when a dev server port may already be in use; it reports the owner when possible and suggests the next free port without killing user processes.
16. When `done`, `goal update --status complete`, or `verify final` returns a `post_goal_self_heal_offer`, tell the user it is optional and confirmation-gated. If approved, read `self-heal context`, ask Codex and Claude for recommended harness/tool improvements, record accepted ideas with `self-heal recommend` or `self-heal request-change`, and address them only through normal implementation/refactor tasks with proof.
17. When `done` or `verify final` returns a `post_build_refactor_offer`, tell the user it is optional. If approved, create/start it with `refactor offer` and `refactor start`, import Codex and Claude recommendations, run `refactor compare`, then `refactor taskify --create` so accepted refactors become normal goal-backed tasks.

## Post-Build Refactor Loop

Use this when the user approves the optional refactor pass after a build:

```bash
node agent-team/src/cli.js refactor offer --goal <goal> --scope repo
node agent-team/src/cli.js refactor start <offer-id>
node agent-team/src/cli.js refactor import --run <run> --source codex --json codex-refactor.json
node agent-team/src/cli.js refactor import --run <run> --source claude --json claude-refactor.json
node agent-team/src/cli.js refactor compare --run <run>
node agent-team/src/cli.js refactor taskify --run <run> --create
```

Rules:

- Both Codex and Claude receive the same high-effort refactor prompt.
- Codex should use max useful native subagents; Claude should use Agent Teams for Claude-owned frontend refactor slices.
- Recommendations stay `advisory_only` until Codex taskifies them.
- Codex remains final task breakdown, merge, proof, and done authority.

## Feedback And Self-Heal

Before changing the harness CLI, plugin, skill, tests, docs, routing policy, or bridge behavior, read the self-heal context first:

```bash
node agent-team/src/cli.js self-heal context --limit 10
```

Treat `.agent-team/state/advisory/self-heal-recommendations/*.json` as the durable source for pending harness/tool improvements. SQLite indexes these records for inspection and recovery, but JSON advisory records plus events are authority.

Record user comments, scope corrections, and harness improvement ideas with:

```bash
node agent-team/src/cli.js feedback record --goal <goal> --scope harness --text "<feedback>"
node agent-team/src/cli.js self-heal recommend --goal <goal> --recommendation "<recommendation>"
node agent-team/src/cli.js self-heal request-change --from claude --surface skill --request "<requested improvement>"
node agent-team/src/cli.js self-heal approve <recommendation-id> --note "<human approval>"
node agent-team/src/cli.js self-heal mark-applied <recommendation-id> --note "<what changed>" --evidence "<tests/proof>"
```

Claude and Codex may submit `self-heal request-change` or `self-heal recommend` records any time they notice the system CLI, skill, plugin, harness, docs, tests, routing, browser/computer-use proof, mailbox, or coordination workflow should improve. Treat hiccups as product feedback: record the recommendation now, keep the main goal moving when safe, then review queued self-heal context after the goal completes. If the hiccup blocks the current goal, surface the recommendation immediately and fix it through normal task/proof gates after user approval.

Self-heal recommendations require user confirmation. Approval records intent in `policies/approvals.jsonl`; it does not apply code, change task scope, or mark work done by itself. Only after a normal implementation/refactor task changes the harness and proof passes should Codex run `self-heal mark-applied`.

## Parallel Worktrees

Use worktrees when Codex and Claude should work in parallel or when a teammate needs an isolated checkout:

```bash
node agent-team/src/cli.js worktree create <task>
node agent-team/src/cli.js worktree status <task>
node agent-team/src/cli.js worktree snapshot <task> --message "Task snapshot"
node agent-team/src/cli.js worktree merge <task>
node agent-team/src/cli.js merge <task> --strategy worktree
```

Rules:

- `worktree create` claims the task lease and creates a branch under `.agent-team/worktrees/` by default.
- `worktree snapshot` rejects changes outside the task's `allowed_paths` or inside `forbidden_paths`.
- `worktree merge` is allowed only after cross-model review moves the task to `merge`.
- `worktree merge` imports the snapshot with `git merge --squash`; Codex still records the final merge, proof, and `done`.
- `verify final` fails if unfinished worktrees remain.

## Turbo Parallelism

Default execution is `turbo_parallel`: use the fastest safe path once tasks are split.

```bash
node agent-team/src/cli.js codex-subagents import --json codex-subagents.json
node agent-team/src/cli.js codex-subagents list --task <task>
node agent-team/src/cli.js codex-subagents show <import-id>
```

Rules:

- Use Codex native subagents aggressively for separable Codex-owned slices and proof-prep/review slices.
- Use Claude Agent Teams aggressively for separable Claude-owned frontend slices.
- Keep task owners coarse: `codex`, `claude`, or `human`.
- Subagent and Agent Teams imports are evidence/advice unless their changes land through a validated worktree merge.
- Parallel writes require disjoint scopes, leases, or task worktrees.
- Codex still owns final merge, proof, and `done`.

## Claude Agent Teams

Use Agent Teams only as a Claude-side frontend accelerator:

```bash
node agent-team/src/cli.js agent-teams import --json agent-teams.json
node agent-team/src/cli.js agent-teams list --task <task>
node agent-team/src/cli.js agent-teams show <import-id>
```

Rules:

- Agent Teams imports are accepted only for Claude-owned frontend tasks.
- Imports must include at least one subagent.
- `changed_paths` must stay within the task's `allowed_paths` and outside `forbidden_paths`.
- Imports are advisory/evidence records only.
- Imports do not move task state, replace cross-model review, satisfy proof, merge code, or bypass `verify final`.

## MoA Advisory

MoA is advisory only. Use it for hard planning, risky architecture, confusing bugs, or disagreement between Codex and Claude:

```bash
node agent-team/src/cli.js moa record --json moa-council.json
node agent-team/src/cli.js moa list --scope task --subject <task>
node agent-team/src/cli.js moa show <council-id>
```

Rules:

- MoA records must include at least two participants.
- MoA records must remain `advisory_only: true`.
- `decision_owner` must be `codex`.
- MoA records do not move task state, replace cross-model review, satisfy proof, or bypass `verify final`.

Use `events --task <task>` when preparing a handoff, checking compaction continuity, or explaining how a task reached its current state.

Use `watch` as the operator dashboard while work is active:

```bash
node agent-team/src/cli.js daemon start --roles codex,claude --include-existing
node agent-team/src/cli.js daemon status
node agent-team/src/cli.js watch --target codex-agent-team-harness
node agent-team/src/cli.js cockpit --no-live-channel
node agent-team/src/cli.js await reply --request-id req_... --once
```

Use the mailbox as the realtime asynchronous push lane from Claude to Codex:

```bash
node agent-team/src/cli.js mailbox watch --to codex --unacked --interval-ms 1000
node agent-team/src/cli.js mailbox send --from claude --to codex --kind checkin --task T-000001 --subject "Still working" --body "Waiting on frontend Agent Teams."
node /abs/path/to/agent-team/src/cli.js --cwd /abs/path/to/harness mailbox send-batch --json claude-replies.json
node agent-team/src/cli.js channel dispatch --kind review --task T-000001 --prompt "Review this without blocking Codex."
node agent-team/src/cli.js channel steer --kind ui_direction --task T-000001 --goal G-000001 --subject "ACK REQUIRED" --file path/to/instruction.md
node agent-team/src/cli.js mailbox list --kind receipt_ack --limit 10
node agent-team/src/cli.js mailbox send --from claude --to codex --kind reply --in-reply-to msg_... --request-id req_... --subject "ACK: received" --body "ACK: received. I will do X next. Answer/blocker: ..."
```

Use `channel steer` for critical steering where Claude must not miss the instruction. The command succeeds once the durable mailbox request is queued; a failed live-channel attempt is a transport problem, not message loss. The receiving daemon may send a quick `receipt_ack`, but the receiving model still owes a semantic mailbox reply for requests, `reply_required` messages, and explicit `semantic_ack_required` messages. Non-required notify/reply messages remain visible as advisory inbox items until read or acked.

Mailbox replies must use the harness-side `request_id` created by Codex, not any MCP-side channel id. `plan import-claude`, `review import`, and `reground import` reconcile mailbox replies first, then fall back to legacy `responses.jsonl`.

Mailbox inbox/watch output includes malformed-JSONL diagnostics. Treat malformed mailbox rows as a state repair blocker; plan/review/reground imports refuse to consume mailbox replies while the mailbox or ack log is corrupted.

`mailbox send-batch` validates the full batch before writing, appends messages through the same durable mailbox path as `mailbox send`, reads every message back, and exits nonzero with per-message failures if anything does not land. If batch delivery fails, record or inspect the emitted self-heal recommendation instead of silently retrying a brittle shell loop.

Use `await reply --request-id <id>` as the first-class durable waiter for exact replies. It watches mailbox state, reports recent check-ins/heartbeats, and does not treat live-channel timeouts as lost work.

The launcher injects the teammate boot contract into every Claude startup prompt and instructs Claude to visibly ACK that mailbox is truth.

Use Claude steering notices and structured check-ins as slower/fallback advisory lanes. Claude can write notices to `docs/planning/claude-notice-<topic>.md`, `docs/schema-changes/claude-notice-<topic>.md`, or `.agent-team/comms/codex-inbox/claude-notice-<topic>.md` inside the project. Codex should run `notice scan --project-dir <project-root>` and inspect `checkin list --from claude --ack-status new` after compaction, channel timeout, visible Claude activity, owner-sensitive changes, or before resuming a task where Claude owns or reviews work.

Never edit generated projections under `.agent-team/projections/` as truth. Regenerate them with `board`.

## Claude Channel

Use the configured local Claude channel bridge through the harness adapter, not a custom transport.

Expected setup:

```bash
node agent-team/src/cli.js channel install
node agent-team/src/cli.js channel mcp status
node agent-team/src/cli.js doctor --fix --target codex-agent-team-harness
node agent-team/src/cli.js channel ensure --name codex-agent-team-harness
node agent-team/src/cli.js channel ensure --name my-project --project-dir /path/to/project --fresh-claude
```

Probe before asking:

```bash
node agent-team/src/cli.js channel doctor --fix --target codex-agent-team-harness
node agent-team/src/cli.js channel status --target codex-agent-team-harness
```

If `channel ensure` returns `claude_auth_required`, stop live Claude startup and report that Claude Code must be authenticated before the teammate receiver can be launched. Do not mislabel this as a generic channel or harness failure.

Use the harness auth helper instead of making the user remember Claude CLI details:

```bash
node agent-team/src/cli.js channel auth
node agent-team/src/cli.js channel auth login
```

Send bounded synchronous live asks through the harness only when a reply-required smoke/proof check is explicitly needed:

```bash
node agent-team/src/cli.js channel ask --target codex-agent-team-harness --task T-000001 --kind review --timeout-ms 60000 --prompt "From Codex: review this. Reply through complete_channel_request."
```

If the channel fails, preserve the failed response row and continue through mock/manual only when that is acceptable for the current phase.

## Handoff And Re-Grounding

After three failed attempts by the current owner on the same blocker, run `handoff <task>`. After both owners hit the same budget, escalate to the human.

Use `reground request <task>` and `reground import <task>` after compaction, owner changes, repeated blockers, or user changes to acceptance criteria. Use `reground <task> --json <file>` only when importing an externally prepared packet. Accept only faithful packets; if the packet contradicts canonical task JSON, treat it as drift and do not use it as authority.

## Verification

Before claiming completion:

```bash
cd agent-team
npm test
cd ..
node agent-team/src/cli.js verify final   # when canonical tasks exist
```

For this harness, the minimum green bar is the Node test suite plus any live-channel smoke required by the task. Report live-channel status honestly: installed, endpoint registered, reachable, ask answered, or blocked with exact stderr.
