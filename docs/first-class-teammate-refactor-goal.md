# First-Class Teammate Refactor Goal

Created: 2026-06-30
Status: Active refactor charter; Phase 10 visible-Claude startup failures now block by default, full architecture review still open
Scope: Agent Team Harness, Claude/Codex communication, visible teammate UX, MCP/channel transport, daemon, cockpit, docs, tests, and installed skill contract.

## Goal Prompt

Refactor Agent Team Harness from a brittle MVP into a first-class production-grade local teammate system for Codex and Claude Code.

The final product must feel like two visible coding teammates working together, not like a pile of wrappers, stale waiters, polling files, hidden background tasks, and timeout confusion. Codex should be able to steer Claude visibly. Claude should be able to answer Codex in a way that lands in the Codex thread or cockpit quickly and unambiguously. If live delivery fails, the system must degrade to a polished manual copy/paste packet instead of pretending work was delegated.

Keep refactoring until the architecture is genuinely clean. Do not stop at a narrow bug fix if the architecture still has obvious coordination debt, leaked transport concepts, duplicate work paths, unclear receipt semantics, or user-visible confusion. Continue through design, implementation, tests, docs, and dogfood verification until the system satisfies the architecture satisfaction criteria in this document.

Preserve a running record in this file after each meaningful phase:

- What changed
- Why it changed
- Files touched
- Tests/proof run
- Remaining architectural discomfort
- Next phase

This file is the compaction survival artifact. If a future Codex or Claude session loses chat context, it must resume from this document plus repo state and continue until the architecture satisfaction review passes.

## Product Principle

One mailbox. One daemon. Two MCP surfaces. Thin live projections. Beautiful fallback.

Anything else must justify itself.

## Non-Negotiable Invariants

1. The durable mailbox/event log is the communication source of truth.
2. Task state changes only through validated Agent Team Harness commands and proof gates.
3. Live Claude Channels are a projection/wake path, not durable truth.
4. Codex App/thread wake is a projection/wake path, not durable truth.
5. MCP tools are the agent API, not another orchestrator.
6. The daemon owns delivery, retry, receipt, and wake behavior.
7. Claude-owned work is not considered delegated until visible Claude delivery is healthy, unless the user explicitly chooses quiet/manual mode.
8. Manual copy/paste fallback must be first-class and fast, not embarrassing.
9. Raw `ask_claude`, `complete_channel_request`, endpoint-name guessing, and timeout-driven status are not production workflow primitives.
10. User-facing language must say what happened: queued, delivered, seen, acknowledged, replied, imported, applied, or blocked.

## Official Surface Map

Use the official product primitives directly.

### Codex

- `AGENTS.md`: durable repo/project instructions.
- Skills: repeatable workflows and operator procedures.
- Plugins: packaging for skills, MCP servers, hooks, and assets.
- MCP: tools/context exposed to Codex.
- Hooks: lifecycle enforcement and local policy checks.
- Thread automations: fallback heartbeat for same-thread polling, not the primary real-time path.
- Codex app-server or SDK: deeper client integrations, thread/turn steering, streamed events, and possible first-class Codex wake adapter.
- Native subagents: parallel analysis/implementation support, not the cross-product transport itself.

Primary docs:

- https://developers.openai.com/codex/
- https://developers.openai.com/codex/mcp
- https://developers.openai.com/codex/app/automations
- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/hooks

### Claude Code

- MCP server: direct extension point for tools and channel behavior.
- `experimental["claude/channel"]`: declares a Claude Channel.
- `notifications/claude/channel`: live projection into visible Claude Code.
- MCP tools: Claude replies, ACKs, check-ins, status, and permission relay.
- Hooks and sessions: local policy and continuity, not stable transcript parsing.
- Permission relay: useful later, but do not confuse tool-use approval with project trust or user consent.

Primary docs:

- https://code.claude.com/docs/en/overview
- https://code.claude.com/docs/en/channels-reference
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/permission-modes

## Target Architecture

```text
agent-team core
  durable goals/tasks/proof state
  append-only mailbox/event log
  JSON/JSONL mirrors plus SQLite indexes
  validated state transitions

agent-team daemon
  single local process per project/session
  watches mailbox/events
  writes receipt and delivery state
  routes live projection events
  retries bounded transport failures
  exposes health and next action

agent-team-codex MCP
  mailbox.send
  mailbox.read
  mailbox.ack
  mailbox.watch
  task.status
  task.claim
  task.review_import
  proof.status
  cockpit.snapshot
  fallback.packet
  fallback.import_reply

agent-team-claude MCP + Claude Channel
  declares experimental claude/channel
  receives daemon live notifications
  exposes reply/ack/checkin/status tools
  optionally relays permissions
  never owns task truth directly

Codex wake adapter
  app-server/SDK based if possible
  thread automation fallback only if necessary
  turns Claude->Codex mailbox events into visible Codex thread/cockpit messages

cockpit UI
  two-seat teammate dashboard
  human-readable presence and receipts
  compact by default, detailed on failure

manual fallback
  copy Claude packet
  import Claude reply
  records mailbox-compatible artifacts
```

## Delete Or Demote

These are architectural debts to remove from the normal path.

- `claude-channel-cli` as a required product dependency.
- Codex plugin wrapping `claude-channel-cli`.
- Raw `ask_claude` as work delegation.
- `complete_channel_request` as task coordination.
- Live-channel timeout states as work status.
- Endpoint display names as primary routing identity.
- Shell parsing of wrapper JSON for normal workflow.
- Multiple user-facing commands that all mean "send Claude a thing."
- Any status label that requires the user to understand internal implementation names.

Keep only what is worth reimplementing first-party:

- Claude Channel notification behavior.
- Visible Claude session wake/projection.
- Local bearer-token style safety.
- Large prompt/file delivery.
- Health checks.
- Persisted transport diagnostics.

## Required Refactor Tracks

### Track 1: First-Party Claude Channel Adapter

Build `agent-team-claude-mcp` inside this repo.

Requirements:

- Runs as a plain MCP server.
- Registers with Claude Code using documented MCP config.
- Declares `experimental["claude/channel"]`.
- Emits `notifications/claude/channel` for live messages.
- Provides tools for:
  - `agent_team_ack`
  - `agent_team_reply`
  - `agent_team_checkin`
  - `agent_team_status`
  - `agent_team_open_task`
- Uses mailbox message IDs, task IDs, and session IDs as stable identity.
- Does not invent a second request lifecycle.
- Does not rely on `complete_channel_request`.
- Has smoke tests with a fake Claude Channel transport.

Exit criteria:

- Codex can queue a Claude-bound mailbox message.
- Daemon projects it into visible Claude through the first-party MCP/channel server.
- Claude can reply through the first-party MCP tool into the durable mailbox.
- No normal path command shells out to `claude-channel-cli`.

### Track 2: Codex MCP And Wake Adapter

Build `agent-team-codex-mcp`.

Requirements:

- Exposes mailbox/task/proof/cockpit/fallback tools to Codex.
- Uses server instructions to explain the one true workflow.
- Supports read/watch operations without raw file spelunking.
- Provides a wake strategy:
  - Primary: Codex app-server/SDK if practical.
  - Secondary: Codex thread automation heartbeat.
  - Tertiary: cockpit/watch notification.
- Makes Claude->Codex messages visible in Codex as soon as possible.

Exit criteria:

- Claude sends `test 123`.
- Message lands in durable mailbox.
- Daemon creates a Codex wake event.
- Codex-side adapter surfaces it in the current Codex thread or cockpit without manual polling where supported.
- If true thread injection is unavailable, status says exactly which product surface is missing and offers the fallback.

### Track 3: Single Daemon, Real Event Semantics

Simplify the daemon until it is obviously the only delivery bridge.

Requirements:

- Enforce one active daemon per project/session.
- Stale PID/run records cannot hide active daemons.
- File watching or event subscription should replace sleepy polling where possible.
- Receipt levels are explicit:
  - queued
  - daemon_seen
  - delivered
  - seen
  - semantic_ack
  - reply
  - imported
  - applied
  - blocked
- Daemon writes clear structured delivery events.
- Daemon never mutates task state directly.

Exit criteria:

- Cockpit can render the exact cross-agent delivery chain for any message.
- User never sees "timeout" as if it means lost work.
- Stale completed work is classified as audit history, not active pending work.

### Track 4: Teammate Cockpit UX

Make the visible experience feel like collaboration.

Required UX:

```text
Codex Active | Claude Visible | Mailbox Healthy | Last reply 12s ago
```

Message receipt line:

```text
Queued 10:42:01 -> Delivered 10:42:02 -> Seen 10:42:04 -> ACK 10:42:09
```

Presence states:

- Claude opening
- Claude ready
- Claude reading
- Claude working
- Claude replying
- Claude stale
- Claude unavailable

Claude->Codex message card:

```text
Claude says:
"..."

[Use this] [Ask follow-up] [Reject] [Open full message]
```

Failure copy:

- "Visible Claude did not launch. Codex cannot claim Claude is working yet."
- "Claude received the message, but has not confirmed understanding."
- "The durable message is saved, but live delivery failed."
- "Fallback packet is ready."

Exit criteria:

- The user can tell in under five seconds whether Claude is open, reading, working, replying, or blocked.
- Internal names like `semantic_ack_required` are hidden behind human language.

### Track 5: Manual Fallback Packet

Manual fallback must beat broken automation.

Packet format:

```text
From Codex to Claude
Project: <project>
Task: <short task name>
Current goal: <goal>
What I need from you: <specific ask>
Do not change: <constraints>
Relevant files/context: <paths or summary>
Reply required:
1. ACK what you understood.
2. Say what you will do next.
3. Report blockers or risks.
4. Paste your result back to Codex.
```

Requirements:

- `fallback packet` command renders the packet.
- `fallback import` command imports Claude's pasted answer.
- Imported fallback replies become mailbox-compatible records.
- Manual mode cannot bypass review, merge, or proof gates.

Exit criteria:

- If live Claude fails, a human can copy/paste to Claude in one click/command.
- Codex can import the reply cleanly and continue.

### Track 6: Command Surface Simplification

Collapse command sprawl.

Preferred operator commands:

- `agent-team start`
- `agent-team send`
- `agent-team watch`
- `agent-team reply`
- `agent-team status`
- `agent-team recover`
- `agent-team fallback`

Existing detailed commands can remain internally or as advanced commands, but normal docs and skills should route users through the simple surface.

Exit criteria:

- README quickstart does not mention raw `ask`, `complete_channel_request`, endpoint guessing, or wrapper install details.
- Skill instructions do not teach obsolete workflow paths.
- There is one obvious way to send Claude a work request.

### Track 7: Session Identity And Resume

Fix routing identity.

Requirements:

- Stable IDs:
  - project_id
  - workspace_path
  - codex_thread_id
  - claude_session_id
  - mailbox_id
  - daemon_run_id
- Old Codex threads should prefer old Claude sessions for the same project/thread.
- New Codex threads should create or bind to new Claude sessions unless explicitly sharing.
- Names are display labels only.

Exit criteria:

- No routing depends on display-name uniqueness.
- A same-project old-thread resume finds the right Claude context when possible.
- Cross-project session reuse is explicit and warned.

### Track 8: Tests, Dogfood, And Proof

The refactor is not done until the system proves itself.

Required tests:

- Unit tests for message schema and receipt state machine.
- Daemon tests for stale PID cleanup, event handling, and delivery transitions.
- MCP server tests for Codex and Claude tools.
- Fake Claude Channel tests for notification delivery.
- Fallback packet render/import tests.
- Cockpit snapshot tests.
- Regression test for "Claude sent test 123 and Codex surfaced it."
- Regression test for "notify/checkin wakes visible Claude, not only reply-required work."
- Regression test for "timeout does not mean lost work."

Dogfood scenario:

1. Start Codex and visible Claude for a test project.
2. Codex sends a Claude-owned task.
3. User sees Claude receive it.
4. Claude ACKs semantically.
5. Claude sends a check-in.
6. Codex sees it without manual mailbox spelunking.
7. Claude replies.
8. Codex imports reply.
9. Codex applies/records outcome.
10. Final cockpit receipt chain is complete.

Exit criteria:

- Automated tests pass.
- Manual dogfood transcript is saved under `docs/proof/` or `.agent-team/evidence/`.
- The architecture satisfaction review below passes.

## Architecture Satisfaction Review

Before declaring this refactor done, answer these questions in this document.

1. Is there exactly one durable communication truth?
2. Is there exactly one normal delivery daemon?
3. Are Codex and Claude both using MCP/mailbox APIs instead of wrapper-specific commands?
4. Are live channels only projections/wake paths?
5. Can the user see Claude receive steering when Claude owns work?
6. Can Claude messages land in Codex without manual mailbox inspection where the Codex surface supports it?
7. If live delivery fails, is fallback faster than debugging the automation?
8. Are all receipt states human-readable?
9. Are obsolete terms removed from user-facing docs?
10. Does the code feel simpler than before?
11. Would copy/paste be slower than the harness in the common case?
12. Would a future Codex session understand what to do from this file alone?

If any answer is "no," continue refactoring or record a deliberate, justified limitation.

## Proposed Implementation Order

1. Freeze this document as the refactor source of truth.
2. Add or update tests for current failure modes.
3. Create first-party message/receipt schema.
4. Refactor daemon around explicit receipt transitions.
5. Build first-party Claude MCP/channel adapter.
6. Remove normal-path dependency on `claude-channel-cli`.
7. Build Codex MCP tools.
8. Add Codex wake strategy and clear fallback.
9. Simplify CLI/docs/skill command surface.
10. Build cockpit receipt/status rendering.
11. Add manual fallback packet/import.
12. Dogfood with real Codex and visible Claude.
13. Run architecture satisfaction review.
14. Only then mark complete.

## Out Of Scope Unless Needed

- Hosted multi-user cloud service.
- Central broker outside the local machine.
- Replacing Codex or Claude native permission systems.
- Parsing internal Claude transcript JSONL as stable API.
- Remote network sync.
- More than one daemon per project/session.

## Running Change Log

### 2026-06-30 - Goal Prompt Created

What changed:

- Added this durable refactor goal prompt and architecture charter.
- Created harness goal `G-000002`: "First-class Codex Claude teammate harness refactor".
- Recorded this Markdown file as Codex's plan for `G-000002` at `.agent-team/state/plans/G-000002/codex.md`.

Why it changed:

- The existing harness proved the right idea, but with too much wrapper leakage and confusing coordination behavior.
- The user explicitly requested a detailed Markdown file that future runs can use after compaction.
- The user asked to create a harness goal and point it to this Markdown source of truth.

Files touched:

- `docs/first-class-teammate-refactor-goal.md`
- `.agent-team/state/goals/G-000002.json`
- `.agent-team/state/plans/G-000002/codex.md`

Tests/proof run:

- Verified `G-000002` goal JSON exists and its objective points to `/Users/andrewguzman/Documents/Playground/agent-team-harness/docs/first-class-teammate-refactor-goal.md`.
- Verified `.agent-team/state/plans/G-000002/codex.md` contains this refactor charter.

Remaining architectural discomfort:

- The current implementation still depends on `claude-channel-cli`.
- Codex wake is not first-class.
- The command surface still leaks raw channel concepts.
- Cockpit does not yet provide the full human receipt chain.

Next phase:

- Lock the current failure modes with tests, then begin Track 1 and Track 3 in parallel.

### 2026-06-30 - Phase 1 Daemon Live Notify And CLI Help Guard

What changed:

- Changed the receiver daemon so every Claude-bound non-heartbeat mailbox message gets a visible Claude live wake when a live endpoint exists, not only reply-required or semantic-ACK requests.
- Split live wake prompt language into required-action prompts for semantic work and visible-action prompts for advisory notify/checkin traffic.
- Added a nested help guard so `goal new --help` and similar help calls print usage without mutating state.
- Added regression coverage for non-required notify live wake behavior and read-only nested help.
- Updated README and the packaged harness skill wording to match the mailbox-first, daemon-live-wake contract.

Why it changed:

- The user expectation is that messages to Claude should feel real-time and visible, even when they are ordinary `notify` or `checkin` messages rather than formal work requests.
- Treating only reply-required messages as live-wake-worthy made the mailbox feel like a black hole and forced manual polling.
- A production-grade CLI must never create goals or other state from a help command; the accidental `goal new --help` ghost goal was a command-surface footgun.

Files touched:

- `agent-team/src/daemon.js`
- `agent-team/src/cli.js`
- `agent-team/tests/cli-smoke.test.js`
- `README.md`
- `plugins/agent-team-harness/skills/agent-team-harness/SKILL.md`
- `/Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md`
- `docs/first-class-teammate-refactor-goal.md`

Tests/proof run:

- `node --test tests/cli-smoke.test.js` from `agent-team/`: 51 tests passed.
- `npm test` from `agent-team/`: 104 tests passed.

Remaining architectural discomfort:

- Normal live projection still shells through `claude-channel-cli`; Track 1 must replace this with a first-party Claude MCP/channel adapter.
- Codex wake still depends on queued wake payloads and optional external command configuration; Track 2 must make Codex-side surfacing first-class where the product surface allows it.
- Receipt semantics are improved but not yet the full human chain of `queued -> daemon_seen -> delivered -> seen -> semantic_ack -> reply -> imported -> applied`.
- The command surface is safer, but still too broad and wrapper-shaped for a polished public release.

Next phase:

- Start Track 1 by designing the first-party Claude MCP/channel server boundary and fake-channel test harness, while continuing Track 3 daemon receipt-state cleanup.

### 2026-06-30 - Phase 2 First-Party Claude MCP Channel Boundary

What changed:

- Added an experimental first-party Claude MCP/channel module that declares the Agent Team channel contract, builds Claude Channel notification payloads from durable mailbox messages, and exposes mailbox-backed tools for Claude ACKs, replies, check-ins, status reads, and task opening.
- Added a stdio MCP server executable, `agent-team-claude-mcp`, with JSON-RPC frame handling for `initialize`, `tools/list`, `tools/call`, and `ping`.
- Added tests proving the server declares `experimental["claude/channel"]`, preserves mailbox identity and body text in channel notifications, and writes Claude replies/check-ins into the durable mailbox.
- Documented the server in the README as the migration target for replacing the legacy managed `claude-channel-cli` bridge on the normal path.

Why it changed:

- Track 1 needs a first-party replacement seam before the daemon can stop shelling out to `claude-channel-cli`.
- Claude-side replies should be normal MCP tool calls that write mailbox records, not `complete_channel_request` semantics hidden behind a wrapper.
- The architecture needs executable proof, not only a design note, that the MCP/channel boundary can preserve mailbox truth.

Files touched:

- `agent-team/src/mcp/claudeChannel.js`
- `agent-team/src/mcp/claudeServer.js`
- `agent-team/tests/mcp-claude-channel.test.js`
- `agent-team/package.json`
- `README.md`
- `docs/first-class-teammate-refactor-goal.md`

Tests/proof run:

- `node --test tests/mcp-claude-channel.test.js` from `agent-team/`: 4 tests passed.
- `npm test` from `agent-team/`: 108 tests passed.

Remaining architectural discomfort:

- The daemon still delivers live Claude wake-ups through `claude-channel-cli`; the new first-party MCP/channel server is not yet registered, launched, or used by daemon delivery.
- The MCP server has the mailbox reply tools and channel notification payload shape, but not a persistent mailbox watcher that emits live notifications by itself.
- There is no Claude MCP config installer yet for `agent-team-claude-mcp`.
- The server has test coverage with fake stdio frames, but no real visible Claude Code dogfood transcript.

Next phase:

- Wire daemon delivery to a pluggable channel transport so `agent-team-claude-mcp` can become the preferred live projection path, with `claude-channel-cli` demoted to compatibility/diagnostics.

### 2026-06-30 - Phase 3 Daemon To Claude MCP Outbox Wiring

What changed:

- Added first-party Claude MCP outbox paths under `.agent-team/comms/claude-mcp/`.
- Corrected Claude Channel notification shape to the documented `params.content` plus `params.meta` contract.
- Added durable queue/deliver/watch helpers for first-party Claude Channel notifications.
- Updated `agent-team-claude-mcp` so the server watches the outbox and emits queued `notifications/claude/channel` frames while Claude Code keeps the MCP server running.
- Changed daemon Claude-bound live delivery to queue first-party MCP outbox notifications first, then attempt the legacy `claude-channel-cli` wake as compatibility fallback.
- Added regression coverage proving daemon first-party outbox delivery works even when the legacy `.agent-team/comms/claude-channel/session.json` is missing.

Why it changed:

- The first-party MCP/channel server needed to become an actual daemon delivery path, not just a static server seam.
- First-party delivery must not depend on legacy endpoint/session records; Claude Code MCP registration should be enough for the server to receive queued wake-ups.
- The migration needs to preserve current visible behavior while demoting the wrapper to a fallback, not breaking active users during the transition.

Files touched:

- `agent-team/src/paths.js`
- `agent-team/src/mcp/claudeChannel.js`
- `agent-team/src/mcp/claudeServer.js`
- `agent-team/src/daemon.js`
- `agent-team/tests/mcp-claude-channel.test.js`
- `agent-team/tests/cli-smoke.test.js`
- `agent-team/tests/public-contract.test.js`
- `README.md`
- `plugins/agent-team-harness/skills/agent-team-harness/SKILL.md`
- `docs/first-class-teammate-refactor-goal.md`

Tests/proof run:

- `node --test tests/public-contract.test.js tests/mcp-claude-channel.test.js tests/cli-smoke.test.js` from `agent-team/`: 60 tests passed.
- `npm test` from `agent-team/`: 111 tests passed.
- Installed skill sync: plugin skill copied to `/Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md` and verified with `cmp`.

Remaining architectural discomfort:

- There is still no installer/registration command that adds `agent-team-claude-mcp` to Claude Code MCP config automatically.
- The daemon still attempts legacy `claude-channel-cli` compatibility fallback; this is intentional for now but not the final normal path.
- Cockpit does not yet render the first-party Claude MCP outbox/delivery chain in human terms.
- Real visible-Claude dogfood with the first-party MCP server has not been captured.
- Codex wake remains a separate queued payload/optional command path rather than a first-class Codex MCP/app adapter.

Next phase:

- Add Claude MCP registration/install support for `agent-team-claude-mcp`, expose first-party delivery state in cockpit, then dogfood a visible Claude wake through the new path.

### 2026-06-30 - Phase 4 First-Party Claude MCP Install And Cockpit Visibility

What changed:

- Added `agent-team/src/mcp/claudeInstall.js` so the harness can install the `agent-team-claude-mcp` wrapper and register the `agent-team-claude` MCP server in either user or local Claude Code MCP config.
- Added `agent-team channel mcp install` and `agent-team channel mcp status` for direct first-party MCP setup and diagnostics.
- Updated `agent-team channel install` and `doctor --fix` to include first-party MCP setup while preserving the legacy `claude-channel-cli` compatibility bridge.
- Updated visible Claude startup flags to request both the first-party `server:agent-team-claude` channel and the legacy `server:claude-channel-cli` compatibility channel.
- Corrected the Claude Channel notification shape to the official `params.content` string plus string-valued `params.meta` attributes.
- Renamed the first-party server delivery proof from ambiguous "delivered" to `mcp_emitted` in the delivery log and cockpit language, because that proves the MCP server emitted the notification frame, not that visible Claude read it.
- Added cockpit/watch visibility for the first-party Claude MCP outbox: queued, waiting for MCP server, MCP-emitted, legacy fallback attempts, and legacy blocked counts.

Why it changed:

- The first-party MCP path needed to become installable and inspectable, not only a test-only server.
- Cockpit needed to show the transport chain in human terms so users can tell whether a message is queued, emitted by the MCP server, or only moving through legacy fallback.
- The system must stop overstating proof: MCP frame emission is not the same thing as seen/ACK/replied by Claude.

Files touched:

- `agent-team/src/mcp/claudeInstall.js`
- `agent-team/src/mcp/claudeChannel.js`
- `agent-team/src/mcp/claudeServer.js`
- `agent-team/src/bridge/claudeChannel/install.js`
- `agent-team/src/bridge/claudeChannel/launcher.js`
- `agent-team/src/bridge/claudeChannel/auth.js`
- `agent-team/src/cli.js`
- `agent-team/src/cockpit.js`
- `agent-team/tests/mcp-claude-channel.test.js`
- `agent-team/tests/cli-smoke.test.js`
- `agent-team/tests/public-contract.test.js`
- `README.md`
- `scripts/install-codex.sh`
- `plugins/agent-team-harness/skills/agent-team-harness/SKILL.md`
- `docs/first-class-teammate-refactor-goal.md`

Tests/proof run:

- `node --test tests/mcp-claude-channel.test.js tests/cli-smoke.test.js` from `agent-team/`: 60 tests passed.
- `node --test tests/public-contract.test.js tests/mcp-claude-channel.test.js tests/cli-smoke.test.js` from `agent-team/`: 62 tests passed.
- `npm test` from `agent-team/`: 113 tests passed.

Remaining architectural discomfort:

- No real visible-Claude dogfood transcript yet proves `server:agent-team-claude` appears and receives notifications in Claude Code UI.
- Startup currently requests both first-party and legacy channel servers; this is intentionally conservative but still not the final "no wrapper normal path" state.
- Cockpit now shows transport counts, but not a per-message receipt timeline with `Queued -> MCP emitted -> Seen -> ACK -> Reply -> Imported`.
- Codex wake remains queued-payload plus optional command, not a first-class Codex MCP/app adapter.

Next phase:

- Run or capture a real visible-Claude dogfood proof for `agent-team-claude-mcp`, then convert the remaining cockpit receipt timeline and Codex wake adapter gaps into the next implementation phase.

### 2026-06-30 - Phase 5 Real MCP Protocol Fix And Honest Fresh Launch Semantics

What changed:

- Switched `agent-team-claude-mcp` stdio transport to standard newline-delimited JSON-RPC instead of private `Content-Length` frames.
- Kept backwards-compatible frame decoding for existing fake tests while making emitted server responses compatible with Claude Code's real MCP runner.
- Delayed first-party Claude Channel outbox watching until Claude sends MCP `notifications/initialized`, so queued channel notifications cannot appear before the MCP handshake completes.
- Ignored client notifications without replying, and echoed the client's requested MCP protocol version in `initialize`.
- Normalized Claude MCP config entries to Claude's native shape: `type: "stdio"`, `command`, `args`, and `env`.
- Tightened MCP install idempotence so stale config missing `type` or `env` is repaired instead of treated as already configured.
- Fixed `--fresh-claude` startup discovery: a fresh launch now requires a genuinely new same-project endpoint. If no new endpoint appears, startup reports `fresh_start_no_new_endpoint` and does not reuse or rename an old session.
- Added regression tests for the real protocol/lifecycle failure and the fresh-launch false-positive failure.
- Updated the README first-party MCP section with the stdio framing and fresh endpoint invariants.

Why it changed:

- Real dogfood disproved the test-only protocol: `claude mcp get agent-team-claude` could not connect while the tests were green, because the server spoke a private frame format instead of MCP stdio JSON lines.
- A queued outbox watcher at process startup risked corrupting MCP initialization by emitting channel notifications too early.
- The visible launch dogfood exposed a second false confidence bug: `--fresh-claude` launched a Terminal tab but then accepted and renamed an old endpoint, which violates the user's hard rule that visible Claude attach failures must not be hidden.

Files touched:

- `agent-team/src/mcp/claudeServer.js`
- `agent-team/src/mcp/claudeInstall.js`
- `agent-team/src/bridge/claudeChannel/status.js`
- `agent-team/src/bridge/claudeChannel.js`
- `agent-team/tests/mcp-claude-channel.test.js`
- `agent-team/tests/cli-smoke.test.js`
- `README.md`
- `docs/first-class-teammate-refactor-goal.md`

Tests/proof run:

- `node --test tests/mcp-claude-channel.test.js` from `agent-team/`: 6 tests passed.
- Direct stdio JSON-line smoke against `/Users/andrewguzman/.local/bin/agent-team-claude-mcp`: initialize and tools/list returned successfully.
- `node agent-team/src/cli.js channel mcp install --mcp-scope user`: rewrote `/Users/andrewguzman/.claude.json` with the normalized `stdio` MCP entry.
- `node agent-team/src/cli.js channel mcp status --mcp-scope user`: `ok: true`, wrapper exists, config matches expected entry.
- `claude mcp get agent-team-claude` outside sandbox: `Status: Connected`.
- `node --test tests/cli-smoke.test.js --test-name-pattern "fresh Claude|channel mcp|start auto|explicit project|cockpit reports loaded"` from `agent-team/`: 55 tests passed.
- Dogfood mailbox ping `msg_mr0d0fd8_4559ef32` was queued through durable mailbox and cockpit showed daemon receipt plus first-party Claude MCP outbox state.

Remaining architectural discomfort:

- True visible-Claude dogfood is still not complete: a fresh visible launch did not produce a new channel endpoint in the observed run, and the fixed harness now correctly treats that as `fresh_start_no_new_endpoint` instead of success.
- The legacy `claude-channel-cli` endpoint layer is still involved in visible session discovery and startup proof; the first-party MCP path is connected, but visible session identity still depends on the legacy endpoint registry.
- Cockpit still shows counts rather than the full per-message human receipt timeline.
- Codex wake is still queued-payload plus optional command; Track 2 needs a first-party Codex MCP/wake adapter.

Next phase:

- Continue Track 2 with a first-party Codex MCP/wake adapter scaffold, then tighten visible Claude launch/session identity so the first-party MCP path plus endpoint discovery can prove a real fresh visible teammate without relying on endpoint-name luck.

### 2026-06-30 - Phase 6 First-Party Codex MCP Wake Adapter

What changed:

- Added `agent-team-codex-mcp`, a Codex-facing stdio MCP server that reads Claude-to-Codex wake payloads, loads mailbox messages, ACKs messages as Codex, replies to Claude through the durable mailbox, and opens canonical task state.
- Added `agent-team codex mcp install` and `agent-team codex mcp status`.
- Added a local adapter manifest at `.agent-team/comms/codex-mcp/adapter.json` so the Codex-side wrapper, wake stream, receipts stream, and mailbox path are explicit.
- Added Codex MCP receipts at `.agent-team/comms/codex-mcp/receipts.jsonl` plus a `daemon.codex_mcp_message_seen` event when Codex ACKs through the adapter.
- Added cockpit JSON/text visibility for Codex MCP configured state, wrapper presence, manifest path, and pending wake count.
- Updated the installer to write the `agent-team-codex-mcp` wrapper and updated README plus the public Codex skill contract.
- Synced the installed skill copy at `/Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md` to the repo skill.
- Fixed the generic wrapper writer so local `.js` MCP server targets execute through Node instead of relying on executable file mode.

Why it changed:

- Codex wake payloads existed but were still a passive file stream. That made Claude-to-Codex real-time behavior feel opaque because Codex had no first-class adapter contract for reading, ACKing, and replying.
- The harness needed a symmetrical first-party surface: Claude has `agent-team-claude-mcp`; Codex now has `agent-team-codex-mcp`.
- The adapter remains honest: it does not pretend to wake this exact Codex UI by itself. It exposes the clean local MCP/read/reply contract that Codex surfaces, hooks, or future native wake mechanisms can consume.

Files touched:

- `agent-team/package.json`
- `agent-team/src/bridge/claudeChannel/install.js`
- `agent-team/src/cli.js`
- `agent-team/src/cockpit.js`
- `agent-team/src/paths.js`
- `agent-team/src/mcp/codexChannel.js`
- `agent-team/src/mcp/codexInstall.js`
- `agent-team/src/mcp/codexServer.js`
- `agent-team/tests/mcp-codex-channel.test.js`
- `agent-team/tests/cli-smoke.test.js`
- `agent-team/tests/public-contract.test.js`
- `README.md`
- `scripts/install-codex.sh`
- `plugins/agent-team-harness/skills/agent-team-harness/SKILL.md`
- `/Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md`
- `docs/first-class-teammate-refactor-goal.md`

Tests/proof run:

- `node --test tests/mcp-codex-channel.test.js tests/mcp-claude-channel.test.js tests/cli-smoke.test.js` from `agent-team/`: 65 tests passed.
- `node --test tests/public-contract.test.js tests/mcp-codex-channel.test.js tests/mcp-claude-channel.test.js tests/cli-smoke.test.js` from `agent-team/`: 67 tests passed.
- Installed skill sync proof: `cmp -s plugins/agent-team-harness/skills/agent-team-harness/SKILL.md /Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md` returned `0`.

Remaining architectural discomfort:

- Codex MCP exposes a clean local adapter, but it is still a pull/read surface unless a Codex-native MCP integration or local hook actively consumes it.
- Cockpit now reports adapter presence and pending wake counts, but not a full per-message timeline such as `Queued -> Codex MCP read -> ACKed -> Replied -> Imported`.
- The visible-Claude fresh launch problem remains unsolved beyond honest failure reporting; a genuinely new visible endpoint still needs dogfood proof.
- The legacy `claude-channel-cli` endpoint registry is still involved in visible Claude startup/session identity.

Next phase:

- Add a per-message receipt timeline across Claude MCP outbox, legacy wake fallback, Codex wake payloads, Codex MCP reads, mailbox ACKs, semantic replies, and imports. Then return to visible-Claude session identity so first-party MCP plus startup proof can stop depending on legacy endpoint-name luck.

### 2026-06-30 - Phase 7 Cockpit Message Timeline

What changed:

- Added a derived `message_timeline` projection to cockpit JSON/text.
- Timeline rows combine existing mailbox rows, mailbox ACK rows, Claude MCP outbox rows, Claude MCP delivery rows, Codex wake payload rows, Codex MCP receipt rows, and daemon/state events.
- Timeline stages now include `mailbox_sent`, `daemon_received`, `semantic_ack_required`, `receipt_ack_sent`, `claude_mcp_queued`, `claude_mcp_emitted`, `legacy_wake_attempted`, `legacy_wake_skipped`, `codex_wake_queued`, `codex_wake_attempted`, `codex_wake_payload`, `codex_mcp_seen`, `mailbox_ack`, and `mailbox_reply`.
- Added cockpit summary line `Timeline: shown=... candidates=...` and a `## Message Timeline` section with compact stage chains.
- Added a smoke test that drives a Claude-to-Codex check-in through daemon wake, Codex MCP ACK, Codex MCP reply, and cockpit timeline rendering.
- Updated README and the Codex skill contract to document the per-message timeline.
- Synced `/Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md` after the skill update.

Why it changed:

- Counts were not enough. Operators could see that messages were queued or delivered somewhere, but not one coherent story per message.
- The user explicitly wants the Claude/Codex system to feel real-time. A per-message timeline makes slow, missing, or stale legs visible without inventing a second state store.
- The projection keeps mailbox truth intact: it derives from existing durable facts rather than becoming another lifecycle authority.

Files touched:

- `agent-team/src/cockpit.js`
- `agent-team/tests/cli-smoke.test.js`
- `agent-team/tests/public-contract.test.js`
- `README.md`
- `plugins/agent-team-harness/skills/agent-team-harness/SKILL.md`
- `/Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md`
- `docs/first-class-teammate-refactor-goal.md`

Tests/proof run:

- `node --test tests/cli-smoke.test.js tests/mcp-codex-channel.test.js` from `agent-team/`: 60 tests passed.
- `node --test tests/public-contract.test.js tests/cli-smoke.test.js tests/mcp-codex-channel.test.js` from `agent-team/`: 62 tests passed.

Remaining architectural discomfort:

- The timeline is read-only and helpful, but not yet exposed as a dedicated CLI/API command outside cockpit.
- Import stages are task-level approximations (`review_recorded`, `reground_stored`, `plan_reconciled`) rather than exact request-message import receipts.
- Visible-Claude session identity and fresh launch still depend on the legacy endpoint registry.
- The Codex MCP adapter still needs a native Codex-side consumer before it can feel like a push inside this Codex UI.

Next phase:

- Either expose the message timeline as a first-class CLI/API command for debugging, or return to visible-Claude startup identity and reduce dependency on the legacy endpoint-name registry. Prefer visible-Claude identity next because it is still the biggest user-visible trust gap.

### 2026-06-30 - Phase 8 Endpoint-Id Continuity And Fresh Launch Probe

What changed:

- Added prior-session endpoint-id reuse for default same-Codex-thread Claude startup. If `.agent-team/comms/claude-channel/session.json` has a matching `session_identity.thread_ref` and `project_dir`, `channel ensure` now tries that exact endpoint id before falling back to display-name/project matching.
- Added `identity_confidence` to startup records for reused target status, remembered endpoint-id reuse, launched new endpoint, renamed new endpoint, recovered project endpoint, and fresh-launch failure cases.
- Expanded `waitForStartedEndpoint` with an endpoint launch probe that records prior same-project endpoint count, after-launch endpoint count, new/existing/wrong-project targets, checked candidates, selected target, and whether a fresh endpoint was required.
- Added `fresh_launch_probe` to failed fresh startup records so visible-Claude launch blockers explain what changed after the launch command.
- Added compact persisted diagnostics for `remembered_endpoint`, `discovered.probe`, and startup identity confidence.
- Updated the README and skill contract to say display names are labels/fallbacks, not primary identity, and synced the installed skill at `/Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md`.

Why it changed:

- The user asked why old Codex chats cannot naturally resume old Claude threads, and why endpoint naming is doing so much work. The harness needed a stable continuity layer based on the previously selected endpoint id plus Codex thread identity.
- Fresh visible Claude launch failures were still too hard to inspect. A blocker should prove whether no endpoint appeared, only old endpoints remained, or candidates were checked but unhealthy.
- This phase reduces endpoint-name luck without pretending the legacy endpoint registry is gone. It makes the remaining legacy dependency explicit and auditable.

Files touched:

- `agent-team/src/bridge/claudeChannel.js`
- `agent-team/src/bridge/claudeChannel/status.js`
- `agent-team/src/bridge/claudeChannel/session.js`
- `agent-team/tests/bridge-review-handoff-reground.test.js`
- `agent-team/tests/public-contract.test.js`
- `README.md`
- `plugins/agent-team-harness/skills/agent-team-harness/SKILL.md`
- `/Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md`
- `docs/first-class-teammate-refactor-goal.md`

Tests/proof run:

- `node --test agent-team/tests/bridge-review-handoff-reground.test.js` from repo root: 33 tests passed.
- `node --test agent-team/tests/cli-smoke.test.js` from repo root: 57 tests passed.
- `npm test` from `agent-team/`: 121 tests passed.
- Installed skill sync proof: `cmp -s plugins/agent-team-harness/skills/agent-team-harness/SKILL.md /Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md` returned `0`.

Remaining architectural discomfort:

- The remembered endpoint id still comes from the legacy Claude channel endpoint registry. It is stronger than a display name, but not a first-party Claude session id owned by Agent Team Harness.
- There is still no real captured visible-Claude dogfood proof showing a fresh visible launch producing a new endpoint under the first-party MCP channel path.
- The probe makes failure legible, but cockpit does not yet render this startup probe in a friendly timeline-like UI.
- Codex wake is still not true push into the current Codex thread unless a local Codex consumer reads the Codex MCP/wake stream.

Next phase:

- Promote startup identity/probe details into cockpit/watch so visible-Claude blockers are obvious without opening JSON, then dogfood a real visible Claude launch and decide whether the legacy endpoint registry can be demoted further behind first-party MCP/session identity.

### 2026-06-30 - Phase 9 Cockpit Startup Identity And Probe Visibility

What changed:

- Changed cockpit session loading to compare the last successful `.agent-team/comms/claude-channel/session.json` against the latest `.agent-team/comms/claude-channel/sessions.jsonl` history row, then show the latest startup record when it is newer. This makes failed startup records visible instead of hiding behind an older last-good session.
- Added `session_source`, `identity_confidence`, `reuse_source`, `remembered_endpoint`, `skipped_reuse`, `discovered`, and `fresh_launch_probe` to `cockpit` / `watch --json` Claude session output.
- Added a rendered `Claude startup:` line to `cockpit` / `watch` text output with source, identity confidence, reuse source, remembered endpoint status, and compact probe counts.
- Added a Next Action for `fresh_start_no_new_endpoint` that names the missing new endpoint and points to `claude_channel.session.fresh_launch_probe`.
- Extended the fresh-start CLI smoke test to prove a failed fresh launch is visible in watch JSON and text.
- Updated README and the Agent Team Harness skill contract to document the `Claude startup:` line, then synced the installed skill copy.

Why it changed:

- Phase 8 produced better startup evidence, but operators still had to open JSON logs to understand a visible-Claude blocker.
- Failed startup rows are important current state, not just audit history. Cockpit must not hide them just because the last successful session still exists.
- The user’s core complaint is trust and immediacy. A dashboard line that says exactly what startup identity/probe state exists is a product-level improvement, not cosmetic polish.

Files touched:

- `agent-team/src/cockpit.js`
- `agent-team/tests/cli-smoke.test.js`
- `agent-team/tests/public-contract.test.js`
- `README.md`
- `plugins/agent-team-harness/skills/agent-team-harness/SKILL.md`
- `/Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md`
- `docs/first-class-teammate-refactor-goal.md`

Tests/proof run:

- `node --test agent-team/tests/cli-smoke.test.js --test-name-pattern "fresh Claude start|public"` from repo root: CLI smoke suite ran and 57 tests passed.
- `node --test agent-team/tests/public-contract.test.js` from repo root: 2 tests passed.
- `npm test` from `agent-team/`: 121 tests passed.
- Installed skill sync proof: `cmp -s plugins/agent-team-harness/skills/agent-team-harness/SKILL.md /Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md` returned `0`.

Remaining architectural discomfort:

- The cockpit now renders startup proof, but it still depends on legacy channel endpoint history for visible-Claude launch identity.
- The fresh-launch probe is human-readable but not yet a dedicated `channel startup diagnose` command.
- Real visible-Claude dogfood remains the next hard proof gap.
- Codex wake still requires a local consumer for true push into the active Codex thread.

Next phase:

- Dogfood a real visible Claude startup path and capture evidence. If the endpoint registry still fails to produce a new endpoint even when Claude visibly opens, focus the next refactor on first-party MCP/session identity or a stricter local launch handshake that does not require endpoint-name or endpoint-list inference.

### 2026-06-30 - Phase 10 Startup Failure Must Block Delegation

What changed:

- Dogfooded `agent-team start --fresh-claude --daemon --timeout-ms 20000 --poll-ms 1000` against the live local environment. The first run exposed a crash when a status response had no parsed body while a remembered endpoint existed.
- Fixed the crash in `agent-team/src/bridge/claudeChannel.js` by guarding `initialStatus.parsed` before comparing a remembered target.
- Added regression test `CH-2e channel ensure handles empty display-name status before remembered endpoint reuse`.
- Retried the live visible launch. Terminal opened, but no new same-project Claude endpoint appeared. Startup recorded `fresh_start_no_new_endpoint` with `identity_confidence: fresh_launch_unverified_no_new_endpoint`, two existing same-project endpoints, zero new endpoints, and zero selected candidates.
- Changed `agent-team start` so Claude startup failures block by default. `--strict-claude` was removed from the normal contract and replaced with explicit `--allow-degraded-claude` for diagnostics or intentionally Codex-only work.
- Moved `fresh_start_no_new_endpoint` and `claude_auth_required` cockpit Next Actions into a priority lane so startup blockers cannot be hidden behind mailbox or planning noise.
- Updated CLI usage, README, public skill contract, and public contract tests.

Why it changed:

- The old behavior let the default startup path print a failed Claude startup while still exiting 0 unless the operator remembered `--strict-claude`. That made a failed visible teammate launch look too much like successful delegation.
- The product rule should match the user's expectation: if Claude-owned work requires visible Claude, failed visible startup is a blocker by default.
- Dogfood proved the harness can now say exactly what happened, but also proved the underlying visible endpoint registration problem still exists.

Files touched:

- `agent-team/src/bridge/claudeChannel.js`
- `agent-team/src/cli.js`
- `agent-team/src/cockpit.js`
- `agent-team/tests/bridge-review-handoff-reground.test.js`
- `agent-team/tests/cli-smoke.test.js`
- `agent-team/tests/public-contract.test.js`
- `README.md`
- `plugins/agent-team-harness/skills/agent-team-harness/SKILL.md`
- `docs/first-class-teammate-refactor-goal.md`

Tests/proof run:

- `node --test agent-team/tests/bridge-review-handoff-reground.test.js` from repo root: 34 tests passed.
- `node --test agent-team/tests/cli-smoke.test.js` from repo root: 57 tests passed.
- `node --test agent-team/tests/public-contract.test.js` from repo root: 2 tests passed.
- `npm test` from `agent-team/`: 122 tests passed.
- Live dogfood with visible Terminal launch showed `fresh_start_no_new_endpoint` instead of silent success.
- `node agent-team/src/cli.js watch --once --no-live-channel` showed `Claude startup: source=history_latest confidence=fresh_launch_unverified_no_new_endpoint ... probe=require-new:yes new=0 existing=2 checked=0 selected=none`.
- Installed skill sync proof: `cmp -s plugins/agent-team-harness/skills/agent-team-harness/SKILL.md /Users/andrewguzman/.codex/skills/agent-team-harness/SKILL.md` returned `0`.

Remaining architectural discomfort:

- Visible Claude still opened without producing a new channel endpoint in the live dogfood run. The harness now blocks honestly, but the user still does not get the desired real-time visible teammate handoff.
- `claude-channel-cli` is still the launch/endpoint proof source for visible Claude. First-party MCP exists, but visible startup identity still depends on legacy endpoint observation.
- `--allow-degraded-claude` is necessary for diagnostics, but any degraded mode is still a possible user-experience escape hatch that must stay explicit and rare.
- Codex MCP is implemented and tested, but the project-local adapter was not yet installed in this live checkout during Phase 10 dogfood.

Next phase:

- Install/check the Codex MCP adapter for this repo and dogfood Codex-side wake reading.
- Then attack the visible-Claude launch handshake itself: either make the legacy endpoint registration reliable for visible launches or move visible startup proof to a first-party session handshake that Claude can ACK through MCP/mailbox immediately after opening.
