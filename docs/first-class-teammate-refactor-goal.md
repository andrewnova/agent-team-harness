# First-Class Teammate Refactor Goal

Created: 2026-06-30
Status: Active refactor charter; Phase 3 daemon-to-Claude-MCP outbox wiring verified locally, full architecture review still open
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
