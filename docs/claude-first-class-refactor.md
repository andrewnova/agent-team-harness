# Goal: Make Codex Work Great With Claude Code

Status: **in progress** (started 2026-07-05). Owner: refactor driven by hand until Phase 0
makes the harness reliable enough to dogfood itself.

### Session tally — 2026-07-05
~30 commits landed. **Test suite is fully GREEN: 134 passing / 0 failing** (from 46 failing at
start), zero regressions throughout, eslint `no-undef` green, CI test step now a HARD gate,
tests headless (no window spam). The hermetic launch harness is done: an explicit
`visible_launcher` (fake script that runs the launch command) exercises the real
visible/codex-terminal launch, boot-ack, smoke, and recover-and-reply flows without opening a
window — all launch/ensure/recover/steer tests rewritten to the first-party-MCP contract or
retired where they drove the removed legacy `claude-channel` endpoint model.

DONE + committed: all of Phase 0 (7 units); Phase 1 — tri-state auth, session liveness,
adopt-first reuse, multi-slot sessions, corruption-tolerant JSONL + `state repair`, daemon
singleton, cockpit crash/undefined fixes, DB rebuild-churn, outbox answered-filter, projections
freshness; Phase 2 — teammate skill + symlink hub, `agent_team_self_heal` MCP tool, Claude-proof
state machine (failed-attempt + unscoped-lease). Test modernization: retired the dead-architecture
CH + legacy-channel tests, rewrote CH-7/steer/daemon tests to the first-party-MCP contract.

REMAINING (each needs a dedicated effort, not an assertion tweak):
- **Hermetic launch-proof harness — pattern PROVEN, 12 tests left**. Foundation done: the
  headless guard now allows an explicit `visible_launcher`, so a fake launcher that runs the
  shell command (writing the real launch marker) with a no-op fake `claude` exercises the real
  visible-launch flow hermetically (no window). CH-3b is rewritten to this pattern and passes.
  The pattern for a visible-launch test: fake `claude` (auth ok, else exit 0) + fake launcher
  `sh -c "$1" &` on PATH (or `AGENT_TEAM_VISIBLE_LAUNCHER` for subprocess `start` tests), assert
  `action: started_visible_mcp_pending`, `launch_mode: visible`, and the new launch command
  (mcp-config, `agent-team-claude-launch` channel, env). Remaining 12 by category: visible-launch
  (recover-visible, steer auto-recover, `ensure ... through fake binaries` — apply the pattern);
  **background-mode** `start` tests (auto-ensures, fresh/new-named reuse, explicit project-dir —
  these need real MCP-proof, since a no-op fake yields `started_unproven`); **smoke-timing**
  (CH-3h, CH-6 — need proof-row timing simulation); **codex-terminal** (CH-3d — its own launcher
  mechanism); **legacy-cockpit-runtime** (cockpit transport-ready / health-blocked — drive the
  removed legacy `claude-channel` CLI, so delete or rewrite). Then flip the CI test step to a
  hard gate.
- **Realistic launch proof (1.6)** — write the launch marker after Claude survives ~2s and record
  its PID (pairs with the harness above).
- **Codex inbound lane** — build on `codex exec`/`resume`/app-server, delete the bespoke
  codex-wake surface. New feature; needs a real Codex process to verify.
- **SessionStart hook / startup-prompt shrink** — point the launcher's injected prompt at the new
  teammate skill; coupled to launch behavior.
- **Phase 3 self-heal loop** — auto-file from steer/startup/import failures; surface pending +
  approved-unapplied in `start`/cockpit; `self-heal taskify`; refactor loop over mailbox transport.
- **Smaller**: single MCP registration (drop dual global+launch), per-consumer delivery watermark,
  cockpit pending-truth reconciliation, legacy `channel ask` command removal.

### Progress — 2026-07-05
Done + verified: **0.1** daemon crash (spawnSync import + per-message try/catch; codex-wake
test green), **0.3** ack stub → `receipt_ack` (+ MCP instruction fix; test inverted, file green),
**0.4** `AGENT_TEAM_HARNESS_CWD` fallback (no shadow state — verified live), **0.5** unified
`replyForRequest` (request_id OR in_reply_to, receipts excluded, last match), **0.6** headless
guard (`AGENT_TEAM_HEADLESS` — zero windows), **0.7** dead-code sweep (legacy live-push,
`isReplyTimeout`, `endpointTarget` all deleted) + eslint `no-undef` (passing) + CI `ci.yml`.
Suite: 46→44 failing, **zero regressions**; lint is a green gate.
**0.2 steer timing — DONE 2026-07-05**: a first-party MCP wake that was durably queued/emitted
but not yet replied to is now `steer_state: "queued_awaiting_reply"` (ok, exit 0) with an
`await_reply_command`, instead of the old `first_party_mcp_reply_missing` blocker/exit 1 — the fix
for the 750ms-wait-vs-1000ms-pump false blocker that ruined the telemetry day. `--recover-visible`
(explicit synchronous recovery) and genuine delivery-failure blocking are preserved. Rewrote the
default-steer test to the new contract. Still deferred: `channel ask` / `steer --raw-live` removal
(legacy-channel retirement unit).

Test suite: 46 → **22 failing** across the session, **zero regressions** (each change verified).
CH triage done: deleted 20 obsolete tests that drove the removed endpoint-discovery + legacy
live-channel-adapter architecture, rewrote CH-7 (doctor) to the first-party-MCP contract, added
cross-project-refusal coverage. The remaining 22 are all coupled to pending refactors (launch-proof
1.6, steer-timing 0.2, legacy-channel retirement) and should be modernized WITH each, not
preemptively — see task #8 for the per-group breakdown. CI test step stays continue-on-error
until they land, then flips to a hard gate. Finding on modernization: the 43 are NOT one bucket to grind now. The durable,
decision-independent part (public-contract doc-drift for the removed legacy path) is **done**
(file green). The rest is coupled to future refactors and should be rewritten THERE, not
preemptively: ~25 CH-* tests assert the `ensure()`/session-identity contract slated for the
adopt-first/multi-slot refactor; ~17 cli-smoke steer/daemon tests are coupled to 0.2 and the
legacy-live-push retirement decision. Pinning current flawed behavior now would be throwaway.
CI test step stays `continue-on-error` until those land, then flips to a hard gate.

This is the tracking doc ("goal") for the harness refactor. It is grounded in three review
rounds: a skill/CLI review, a deep runtime review (state/DB, daemon, MCP, channel bridge,
self-heal), and a fresh-lens pass (security, tests, strategy, completeness). Every claim below
carries file:line evidence in the scratchpad review files; the highest-signal facts are inlined.

## The reframe: replace, don't only harden

The June-30 refactor already moved handoffs to first-party MCP as the default, and it works
(the two successful semantic replies that day came from that path). The next step is not to
harden the bespoke push transport — it is to **replace subsystems with platform primitives**
where they now exist, and shrink the harness to the thin cross-model bridge that is its actual
reason to exist (Codex-lead ↔ Claude-teammate; every native multi-agent feature is same-model
Claude↔Claude and cannot replace it).

Decisions that need the user (do not silently pick):
- **Fork consolidation — RESOLVED 2026-07-05.** `agent-team-harness` is canonical;
  `codex-claude-cowork/` is dropped. It has been gitignored to remove the `git add -A` hazard;
  its only functional delta (the dead-`endpointTarget` deletion) is folded into Phase 0.7. The
  directory is left on disk pending an explicit go-ahead to delete it (untracked = no git
  recovery). All work happens in `agent-team-harness`.
- **Push → pull inversion.** Most runtime bugs share one root: push + shared-JSONL mailbox
  raced by 4 processes. The leverage move is one MCP server owning the mailbox as its own
  state, both agents PULL via blocking long-poll tools. Big win, big change — schedule as its
  own phase after Phase 0/1 stabilize the current model.
- **Adopt platform primitives** (Phase 2): `codex exec`/`resume`/app-server for the Codex
  inbound lane (deletes `codexServer.js`/`codexChannel.js`/`codexWakeCommand.js`/`codex-wake/`);
  `SessionStart` hook for startup injection + boot signal; retire `--channels` (research
  preview, not allowlisted for our server — effectively the dangerous dev flag today).

## Phase 0 — Stop the bleeding (verified bugs, each independently testable)

0.1 **Daemon crash + survivability.** `daemon.js:3` imports only `spawn`; `daemon.js:377`
    calls `spawnSync` → ReferenceError whenever a Codex wake adapter is configured (it is:
    `~/.local/bin/agent-team-codex-wake`), thrown uncaught inside the watch callback → kills
    the whole daemon (both comms directions) and crash-loops on restart. Fix: import
    `spawnSync`; wrap per-message handling in try/catch → `daemon.handler_error` event. **[STARTED]**
0.2 **Steer timing.** `channel steer` waits 750ms (`cli.js:572`) but the MCP outbox pump is
    1000ms (`claudeServer.js:106`) — a healthy reply is impossible in the window, so every
    steer exits 1 and funnels into recovery (new window → session hijack). Raise wait to a
    realistic budget; make "no reply yet" exit 0 `queued_awaiting_reply` (reserve exit 1 for
    real transport failure); add staleness escalation.
0.3 **Receipt stub poisons replies.** `agent_team_ack` writes its boilerplate as `kind:"reply"`
    (`mcp/claudeChannel.js:439-453`) → satisfies the semantic-proof gate, saved as the official
    plan by `plan import-claude`, clears cockpit pending forever. Change to `kind:"receipt_ack"`
    (kind exists; every consumer already exempts it). Invert the test that pins the old behavior.
0.4 **Shadow state.** `extractGlobalCwd` (`cli.js:489-500`) ignores `AGENT_TEAM_HARNESS_CWD`
    (already exported into Claude's env), so bare CLI calls from Claude's cwd write a shadow
    `.agent-team`. Add the env fallback in the CLI and the MCP server root; make the global
    user-scope MCP server no-op where no `.agent-team` exists.
0.5 **One reply matcher.** `findSemanticReply(cwd, requestId)` = request_id OR in_reply_to,
    receipts excluded, last match — used by `replyForRequest`, waiter, `findMailboxResponse`,
    cockpit (kills the request_id-only vs in_reply_to and first-vs-last divergences).
0.6 **Headless/hermetic guard.** Tests and smoke probes go through the real
    osascript→Terminal→`claude --permission-mode auto` launch (this spammed real windows during
    review). `AGENT_TEAM_HEADLESS=1` suppresses the visible path in `launchVisible`; `npm test`
    sets it for the parent (covers in-process tests) and cli-smoke `run`/`runRaw` force it into
    every spawned-CLI env (covers subprocess tests — the leak that reopened windows). Verified:
    full suite opens 0 windows.

Phase 1 slice — **session liveness probe (DONE 2026-07-05)**: `sessionProcessAlive()` checks the
recorded MCP-server pid (`mcp_start` proof row) with `process.kill(pid, 0)`; `ensure()` now only
reuses a recorded session when that process is actually alive, instead of reporting a
closed-days-ago window as `delivery_ready`. New `session-liveness.test.js` (3 tests). This is the
foundation the adopt-first default needs. Suite: 106 pass / 43 fail.
0.7 **Dead-code sweep.** Delete legacy live-push block (`daemon.js:128-253`, incl. undefined
    `isReplyTimeout`), undefined `endpointTarget` helpers (`bridge/claudeChannel.js:37-75` —
    the fork already did this), permanently-failing `channel ask`/`steer --raw-live`.

## Phase 1 — Honest status & durable state

1.2 **DB rebuild-churn — DONE 2026-07-05**: mailbox advisory rows are written to SQLite +
    `comms/*.jsonl` but not to the `state/advisory/` JSON mirror that `countAdvisoryMirrors`
    scans, so the SQLite advisory count permanently exceeded the mirror count → `needs_rebuild`
    always true → a full O(history) delete-and-reinsert rebuild on every `state.init` (i.e. every
    mailbox write). `tableCounts` now excludes the `mailbox-messages`/`mailbox-acks` kinds from
    the advisory count so the two sides agree. Verified: `needs_rebuild` stays false after
    mailbox traffic. Test. (Follow-up: `db rebuild` still wipes the SQLite mailbox index since
    it reinserts only from `state/advisory/`; far rarer now, and comms/ stays the truth.)
1.1 **Corruption-tolerant JSONL + `state repair` — DONE 2026-07-05**: `readJsonl` now skips a
    torn/corrupt line instead of throwing (it used to brick every hot-path reader — state.init,
    cockpit, daemon), keeping the bad line in the file so nothing is lost; `readJsonlDetailed`
    surfaces malformed lines. New `state repair [--apply]` quarantines malformed lines from
    events/mailbox/acks logs to a `.rejects` sibling and rewrites a clean log (the review noted
    no repair command existed anywhere). Test drives torn-line-survives + repair. 1.2 Take the O(history) DB rebuild out of the hot path; mirror mailbox
    advisory rows to JSON so `needs_rebuild` stops being permanently true. 1.3 **Outbox answered-filter — DONE 2026-07-05 (partial)**: `deliverQueuedNotifications`
    now skips a queued request that already has a semantic Claude reply, so a fresh/restarted
    consumer (new consumer_id) no longer replays history and re-asks Claude to answer requests
    Codex already got answers to (the telemetry's 110-deliveries-for-12-messages flood, and the
    stale-request re-answer risk). Test. STILL PENDING: one MCP server per session
    (`--strict-mcp-config`, drop the dual global+launch registration); a per-consumer delivery
    watermark so non-reply `notify`/`checkin` notifications also stop full-replaying on restart. 1.4 **Daemon singleton — DONE 2026-07-05**:
    a persistent `runDaemon` used to overwrite the pid record last-writer-wins, so two daemons
    fought over one mailbox (divergent receipt_acks/wakes) and `stopDaemon` only killed one. Now
    a persistent daemon refuses (`daemon_already_running`, exit 1) if a live daemon owns the
    record; `--force` takes over by killing the old one. One-shot (`--once`) wake passes (steer)
    stay exempt. Test. 1.5 **Adopt-first `ensure` — DONE
    2026-07-05**: reuse is now the DEFAULT (not opt-in) — adopts a live recorded same-project+name
    session instead of launching another window; `--fresh-claude` overrides; dead sessions fall
    through. Fixes the "N launches per session" churn. `adopt-first.test.js` (3). **Multi-slot
    sessions — DONE 2026-07-05**: `loadEnsureSession(cwd, {name,target,projectCwd})` selects the
    most recent OK record for that name+project from `sessions.jsonl` history instead of the
    single-slot `session.json`, so a recovery launch (a different name, appended later) can no
    longer clobber/hijack the primary's adoptability (MULTI-1 test). STILL PENDING: README/skill
    docs still describe the old always-launch default (`--reuse-claude` now a redundant alias).
    1.6 Realistic launch proof (marker after Claude survives ~2s). **Tri-state auth detection —
    DONE 2026-07-05**: `claudeAuthStatus` classifies logged_in|logged_out|unverifiable; `ensure()`
    blocks only on definite logged_out (unverifiable proceeds — the boot-ack/MCP proof catches a
    real failure), replacing the prose "sandbox rule" with behavior. Fixed a latent null-stdout/
    stderr `.trim()` crash. New `auth-status.test.js` (4 tests). Suite 103 pass / 43 fail.
    1.7 Cockpit **(partial — DONE 2026-07-05)**: fixed the crash when the `claude` binary is
    unavailable (`result.stdout/stderr.trim()` on undefined took down the whole dashboard in a
    sandboxed shell) and removed the phantom `legacy-fallback=undefined legacy-blocked=undefined`
    render (fields `claudeMcpState` never returns). Test. STILL PENDING: reconcile the two
    contradictory pending-counts, the fictional "delivered" wake counter. 1.8 **Projections freshness — DONE 2026-07-05**:
    `transitionTask` now regenerates the board/health projections after every task-state change
    (lazy require + try/catch so a projection error can never break a transition), instead of
    only on a manual `board` call — fixes the telemetry's "board shows 0 tasks vs N events".
    Test. (Regenerating at the transition choke point is cheap/infrequent, unlike per-message.)

## Phase 2 — Claude first-class + platform primitives

2.1 **Teammate skill + symlink hub — DONE 2026-07-05**: new
    `plugins/agent-team-harness/skills/agent-team-teammate/SKILL.md` gives Claude a durable,
    portable role contract (boundaries, reply/checkin discipline, evidence, notices, self-heal,
    compaction recovery) — previously Claude had no skill, only an injected startup prompt.
    `install-codex.sh` now links both skills through a `~/.agents/skills` hub (repo = source of
    truth): Codex gets only the orchestrator skill, Claude Code gets only the teammate skill;
    backs up (never deletes) any pre-existing real dir. Verified end-to-end in a sandbox.
    STILL PENDING: shrink the launcher startup prompt to point at the skill (or a SessionStart
    hook); salvage the installed-copy drift into the repo before applying the installer on this
    machine. 2.2 **`agent_team_self_heal` MCP tool — DONE 2026-07-05**: Claude can file a harness
    change request (source=claude) directly through MCP; the server runs with `--cwd
    <harness-root>` so it bypasses the shadow-state cwd bug a bare CLI call hits. New test.
    (`agent_team_feedback` deferred — same pattern when needed.) 2.3 Codex inbound lane on
    `codex exec`/`resume`/app-server (delete bespoke codex-wake surface). 2.4 **Claude-proof
    state machine — DONE 2026-07-05 (partial)**: a failed/blocked `attempt` no longer
    auto-advances to `review` (stays `implementing`; the result reports `advanced_to_review`);
    an unscoped task no longer takes a global `*` exclusive lease that serialized all parallel
    work (empty no-op lease instead). Two tests. STILL PENDING: legal `blocked`/backward review
    edges; case-insensitive handoff blocker matching.

## Phase 3 — Close the self-heal loop

3.1 One `autoSelfHeal()` called from steer/startup/wake/import failures (what SKILL.md already
    promises). 3.2 Surface pending + approved-unapplied in `start` and cockpit; `self-heal
    taskify`; `mark-applied` requires linked task proof. 3.3 Refactor loop gets the plan-loop's
    mailbox transport and an explicit JSON schema in the prompt (today imports normalize to
    empty records that still count as accepted).

## Cross-cutting (do alongside, not after)

- **Tests/CI.** Suite is RED now (46/142 failing) and nothing gates it — no CI runs tests, no
  lint. Add eslint `no-undef` (catches spawnSync/isReplyTimeout/endpointTarget in 1s), a
  GitHub Actions `test.yml`, and an in-process integration harness with an injectable clock +
  torn-JSONL fixtures. Two verified bugs are currently *pinned as correct* by their tests —
  invert those.
- **Security.** Mailbox has no sender authentication (any local process can steer an
  auto-permission Claude); `scanClaudeNotices` forges `author:"claude"` on any repo markdown
  with `# NOTICE for Codex` (cross-repo prompt injection); `~/.claude.json` rewritten
  non-atomically with no backup; `--visible-app` AppleScript escaping bug; unredacted PTY
  transcript at rest.
- **Proof integrity.** `verify browser --fake` / `AGENT_TEAM_FAKE_BROWSER_PROOF=1` (and
  `--fake` computer) write synthetic artifacts that `evaluateProof`/`done`/`finalCheck` accept
  as real — the gate never inspects the `fake` flag. Defeats "Codex is proof authority."
- **Retention.** `retention.js` is a documented no-op; nothing prunes/rotates anywhere, so logs
  grow unbounded, worsening the rebuild-per-write and torn-line risks.
- **Dev-mode targets the wrong repo.** Proof/worktree/merge/snapshot all run with cwd=harness
  root and take no `--project-dir`, while Claude edits a different repo — so real external work
  is never captured/verified. Worktree `--squash` never commits and worktrees are never removed.
  Dev mode only works when the project IS the harness (dogfooding).

## Evidence index (scratchpad)

review-cli.md, review-skill.md, review-claudeSide.md, deep-telemetry.md, deep-stateDb.md,
deep-selfHeal.md, deep-channelBridge.md, deep-daemonMcp.md, gap-security.md, gap-testGap.md,
gap-strategy.md, gap-completeness.md, plus proposal-{twoRoleSkills,singleRoleAware,cliGenerated}.md.
