# Partial native shortcut acceptance, 2026-09-06/07

**Status: experiment stopped.** The Codex-led cycle reached acceptance. The Claude-led cycle did not complete review and repair. The coordination overhead and repeated operator intervention do not justify further investment for bounded coding work; direct native sessions remain the default.

This is a functional acceptance record for the first-use changes. It is not a throughput comparison or a production-readiness claim. The tests used disposable counter repositories, real native CLI sessions in cmux, and the installed `team` skills. The target source checkouts were kept separate from coordinator, feature, and worker checkouts.

## Installation and durable handoff

The installer refreshed `team` and `agent-team-harness` for Codex and Claude from a retained clone. All six global links resolved, the two older harness links were backed up, and a repeated installation made zero changes. Fresh native sessions recognized Codex's `$team` picker entry and Claude's `/team` command. Both used the public starter to persist the exact UTF-8 task, with a stable task ID and a semantic lead acknowledgment.

The task required a first `index.html`-only implementation wiring Increment, Decrement, and Reset to existing module exports. Independent review then covered the complete page and module, including a zero floor and native Enter/Space activation. Actual module/test findings required an Astra repair and a fresh review. The cap was three top-level jobs including the lead; native children were optional. Models remained Astra at xhigh and Fable at medium, under native permission settings. The native CLI versions observed were Codex 0.153.4 and Claude Code 2.1.263.

## Codex lead

- The actual shortcut submitted `first-use-codex`; a warm retry reused its lead, attempt, surface, and task body hash.
- The initial Fable frontend worker committed the page change. Its terminal report exposed a real harness defect: operator submissions were placed in the legacy task directory, causing SQLite index rebuilding to reject their schema. The run stopped, its process cleanup was verified, and its failed evidence was retained.
- The fix gives operator submissions their own namespace. A regression reproduced the failure before the fix and then passed. The shortcut resumed the same task with explicit `--resume-task`; the replacement lead reused the existing UI commit and completed only unfinished work.
- Fable review requested changes for `ZERO-FLOOR-001` and `TEST-ZERO-FLOOR-002`. Astra repaired the module and added regression coverage. Required checks passed (7 unit cases and 11 page-contract cases), and a fresh Fable review approved both resolved findings.
- The accepted candidate was `8b9c6f7ef79458ee454aabf3363c0c7d5a2ae5f5`, feature `counter-first-use-b20d88a6`, generation 2.
- Browser clicks and focused Enter/Space activation verified increment, decrement, reset, and repeated decrement at zero on that candidate. The page-contract check uses a minimal DOM; it was not substituted for this browser check.
- A live replacement of approved reviewer attempt 3 made acceptance ineligible. Attempt 4 reached readiness with a native PID, was cancelled, and stopped. Acceptance remained ineligible. Fresh attempt 5 approved and stopped; collection restored eligibility on the same candidate.
- Workers stopped before the lead. Nine exit receipts reported no remaining processes; a live PID/start-time check confirmed those identities were absent. The task record retained its completed semantic reply.

## Claude lead

Initial default discovery selected a transient cmux CLI shim; its wrapper printed `Error: claude not found in PATH` and exited 127 before readiness. New cmux terminals did not inherit the caller PATH needed by that wrapper. Default discovery now skips cmux wrappers while preserving explicit binary overrides and ordinary user wrappers. Ten regressions cover both runtimes, aliases, overrides, and a missing native executable.

The actual `/team` shortcut resumed `first-use-claude` with the same input file and task ID, using the corrected defaults at source `4b6cd64`. Both native CLI paths resolved correctly. The replacement lead reached readiness and durably acknowledged the task. Failed attempts remain preserved. A warm retry reused the same ready lead and acknowledged task. The Claude feature remained unaccepted at candidate `b05f51625c4ab6e6f8ce75d6e53c1ab6e795afef` (generation 1). Required Astra reviewer attempt 1 reached readiness, was interrupted, and stopped. Acceptance remained ineligible. Fresh attempt 2 reached readiness, but the experiment ended before its review result or any module repair. It was cancelled and verified stopped before the lead. This is interruption/restart evidence, not a passed Claude acceptance cycle.

The Fable frontend worker committed an `index.html`-only implementation. Its auxiliary headless Chrome probe hung and it fell back to an executed DOM stub, correctly disclosing that browser gap. During cleanup it used a broad `pkill -f http.server`, which also terminated the operator's separate preview server (exit 143). The operator reported this to the lead and added explicit owned-PID/handle cleanup instructions for future native jobs in `4020bc4`. Those instructions are not operating-system isolation and do not prove model compliance. This observed cleanup mistake remains a material limitation of the supervised run.

## Automated validation

At source `4b6cd64`, all 406 tests and ESLint passed locally; PR CI also passed. The subsequent cleanup instruction passed all 55 native command tests and ESLint; PR CI also passed at `4020bc4`. Coverage includes real subprocess SIGKILL, competing lock recoverers, concurrent installer refresh/rollback, immutable task retry and resumption, the operator/legacy task namespace regression, and native executable discovery.

## Evidence and limits

All active harness jobs were stopped, workers before their leads. Fifteen native exit receipts reported no remaining processes; a live PID/start-time identity check confirmed their recorded processes were absent. The separate operator preview servers are stopped. The unaccepted Claude task and all failed attempts remain preserved without a false completion record.

Native trust prompts required operator handling. The operator also interrupted a long polling command and redirected auxiliary browser work. This was supervised functional testing, not unattended acceptance or a speed benchmark. Codex desktop `@team` picker activation was not exercised; the live Codex entry used the native CLI `$team` picker.

Local raw transcripts and screenshots are not published: native diagnostics may contain private environment values or unrelated desktop content. This record reports task IDs, candidate commits, review outcomes, cleanup observations, and the corresponding automated regressions. The fixture work was not merged or deployed. Browser coverage is limited to the counter controls in the Codex in-app browser; no cross-browser or screen-reader claim is made.
