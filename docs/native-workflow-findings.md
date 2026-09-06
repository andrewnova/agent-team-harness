# Native workflow trial: 6 September 2026

The coordinated workflow has not earned a speed advantage for small tasks. Use a direct native Codex or Claude Code session for one bounded task. Keep full team coordination experimental, for work with substantial independent assignments. More agents do not remove coordination overhead.

## What was exercised

Two disposable counter repositories ran concurrently, one with an Astra lead and one with a Fable lead. Each lead received the same small task: a counter page, a floor at zero, reset, meaningful module tests, separate logic and page workers, an addressed clarification exchange, assembly, and a fresh opposite-runtime review. The harness source was `6b7f59b`.

| Observation | Result |
| --- | --- |
| Cold CLI allocation | 647 ms with a Codex lead; 739 ms with a Claude lead |
| Repeated public startup | Reused the same ready lead and surface in both runs |
| Addressed worker clarification | Request and semantic reply completed in both directions |
| Logic workers | Both committed scoped changes, passed their checks, stopped, and notified their lead |
| Full feature acceptance | Neither run reached acceptance during the twenty-minute observation window |
| Native prompts | New worktree trust and repeated page-worker command approvals required operator handling |
| Final cleanup | Every launched trial job was verified stopped; worktrees and evidence were retained |

The observation ran from 21:42 to 22:02 UTC; the remaining jobs were cancelled at 22:03 UTC. These times include operator waits and concurrent work. This was not an equivalent timed comparison against a direct session, so it does not establish a precise slowdown ratio. It does establish that the small-task workflow missed its usability target.

## Concrete causes and fixes

The harness forced `acceptEdits` for Claude coding jobs, replacing the operator's configured native `auto` policy. Coding jobs now inherit the native policy; reviewers keep explicit read-only restrictions. Global settings are not changed.

Live review also exposed incomplete source read scope, health reporting that could treat a retained terminal as ready, and a mismatch between Claude's observed report-driven exit 143 and the runner's success criteria. Review found a terminal-report failure path that could wake a lead early and duplicate a result on retry. The lifecycle refactor addresses these with scoped reads, exit/child health evidence, verified shutdown handling, and serialized retry receipts.

The trial predates those final fixes. Passing deterministic regressions for the fixes does not turn this trial into a successful live workflow or prove a throughput gain.

## Decision

Retain the small ownership, addressing, and shutdown primitives. Do not add another scheduler, approval layer, or reporting protocol to rescue this trial. Use direct native sessions for ordinary bounded work and a separate focused review when needed.

Before promoting coordinated teams as the default, compare an actual parallel workload against the equivalent direct-session workflow using the same task, models, quality checks, and native permission policy. Record total elapsed time and operator interventions. Keep the coordinated path only where it reduces both meaningful completion time and operator effort. Otherwise simplify or remove that path.
