# Native team acceptance

This is the live acceptance procedure for the public native cmux workflow. The [September 6 trial](native-workflow-findings.md) failed its small-task efficiency target; this procedure is not a claim that the coordinated workflow is accepted. The deterministic suites are `agent-team/tests/team-workflow-e2e.test.js` and `agent-team/tests/team-runner-recovery.test.js`. Passing them does not establish that Astra, Fable, native Agent Teams, cmux tab lifetime, account access, or trust prompts work.

## Deterministic integration coverage

Run with the project's supported Node runtime:

```sh
~/.hermes/node/bin/node --test agent-team/tests/team-workflow-e2e.test.js
~/.hermes/node/bin/node --test agent-team/tests/team-runner-recovery.test.js
```

The suite uses actual subprocess CLI calls, startup, command generation, POSIX launch quoting, `sessionRunner`, JSON-lines session MCP, durable jobs/mailbox, Git worktrees and commits, assembly, frozen candidates, independent review import, and isolated candidate checks. Only the external cmux process and model executable are stand-ins. On Linux CI the startup function receives a macOS host context; this is not a test of the real platform gate. No dependencies are added, and no live model or cmux command is executed. The test preload rejects other external executables, including an accidental real native launcher.

The model stand-in performs the real MCP handshake and accepts a deterministic sequence of tool calls. Test code supplies the model's source change and approval payload; neither is evidence of actual model reasoning. The runner observes real fixture processes with `ps`. A local sandbox that denies process inventory must grant that narrowly scoped observation for this suite; replacing process inventory with pretend stopped evidence would invalidate the test.

| Integrated path | Required assertion |
| --- | --- |
| Startup and ready | Surface allocation stays `launching`; JSON-lines initialize and tool listing succeed; launch-bound ready changes it to `running`. |
| Fresh CLI / persisted restart | A new startup process reuses the exact lead and surface; a new status process reads the same acceptance result. |
| Task and semantic reply | A task sent before recipient readiness stays durable; successful wake alone produces no reply; inbox and reply correlate exact message IDs and attempts. |
| Worker and ownership | The worker reports its commit through MCP; the result initially retains its writer claim; actual native child and observed MCP descendant exit precede stopped evidence and the separate stopped-job wake. |
| Parent assignment | A single active lead supplies `parent_job`; launch binds `parent_attempt`. Multiple leads require an explicit assignment. Notices go only to that parent attempt. |
| Bounded observation | `job wait --until ready` times out without creating readiness; `team status` reports ready/stopping; `job wait --until stopped` observes released ownership for the same attempt. |
| Assembly and checks | A real worker commit is scope-checked and cherry-picked; a check executes the frozen candidate's behavior in an isolated checkout. User source remains unchanged. |
| Independent review | A fresh opposite-runtime read-only job receives the integrated diff; import fails before stopped evidence; current review plus checks permits acceptance. |
| Interrupted review | A second review attempt immediately blocks the earlier approval; cancellation and stale report import remain blocked; a fresh third attempt restores acceptance. |
| Unavailable wake | CLI send returns the delivery error while preserving exactly one durable message; retry wakes the existing ID; transport success never implies a semantic reply. |
| Abrupt process exit | The model exits with code 23 without a report; the runner stops its observed MCP child and records failure before releasing ownership. |
| Stale attempt | Retry has an empty current inbox; old wake and old MCP session are rejected; attempt history persists. |
| Stale candidate | A changed frozen candidate rejects the earlier approval payload, and a broken replacement fails the behavioral check. |
| Evidence integrity | Changed check logs invalidate previously eligible acceptance. |

Limitations: the suite does not emulate the terminal UI, real model execution, account safeguards, native child-agent permissions, controller-tab survival, cold trust dialogs, process-inventory denial recovery, abrupt wrapper death, or detached children that disappear before their parentage can be observed. Those remain live or focused lifecycle tests. It does not claim that reopening the CLI restarts or repairs a dead native session.

The PID-binding failure test isolates the failed persistence write from concurrent MCP writes. A separate local run observed that terminating MCP during its jobs-lock critical section can leave an orphaned lock and prevent the runner from recording final status. The system retains ownership and requires inspection; automatic recovery from that overlapping failure is not implemented or claimed.

`team_report` stores the original semantic result and its `reported_result.message_id` without waking the lead. After `finishJob` records `process_stopped: true`, `jobFinishedMessage` emits a separate deterministic `jobexit_<job-id>_<attempt>` notice with `event: "job_stopped"`. Its body contains the final status and `result_message_id` when a semantic result exists, or failure details when the process crashed without one. The runner wakes the assigned parent using this notice ID and saves a delivery receipt. Retry may resubmit that wake but must reuse the same durable notice; an old sender or parent attempt cannot receive a new delivery.

Both suites must pass on the integrated runtime. The runner regression additionally requires unexpected nonzero native exits to fail even if the model reported completion. Claude's observed exit 143 is accepted only after report-driven supervisor shutdown and verified cleanup; 143 without that context and exit 23 remain failures. Signal warnings do not replace final process proof. The workflow suite checks notice ordering by observing actual persisted sender state at the external cmux send boundary; terminal output alone is insufficient.

## Live run setup

Main owns this procedure. Run only after integrating the runtime/startup/feature changes and passing the repository's required lint and tests. Record the exact harness commit, dirty-tree status, macOS version, cmux version, Node version and path, Codex and Claude executable paths/versions, model IDs, and coordinator path before starting. Use the existing installed tools; preserve native socket, sandbox, trust, account, and model safeguards.

Use a disposable local repository with one clearly scoped visible task and an explicit check. A suitable task is a small local page with a working counter, reset behavior, and keyboard-accessible controls, plus a deterministic test for its state logic. The brief should require one independent reviewer to inspect the complete behavior and the interface between page and logic. Do not count a static screenshot or a terminal's claim as functional proof.

Use a fresh coordinator outside the repository for the cold run. Keep the original checkout clean. From an existing terminal inside cmux, start the public entry point:

```sh
~/.hermes/node/bin/node scripts/start-team.js \
  --project /absolute/disposable-repository \
  --coordinator /absolute/disposable-coordinator \
  --leader codex --max-active 4 \
  --codex-model gpt-6-astra --claude-model 'claude-fable-5-1[1m]' \
  --codex-bin /absolute/validated/codex --claude-bin /absolute/validated/claude
```

Repeat with a separate coordinator and `--leader claude` to verify reversed leadership and fresh Astra reviewers. Astra parents and useful children must use `xhigh`; Fable parents and useful native Claude Code Agent Teams must use `medium`. Read-only reviewers and their children keep their read-only boundary. Capture settings and actual session/model evidence; generated flags alone do not prove the runtime obeyed them.

## Live acceptance matrix

The timing values below are proposed diagnostic budgets for this small canary, not measured performance claims. Record wall time including native prompts and separately record time spent waiting for operator input. A budget overrun triggers evidence capture and diagnosis; it never justifies skipping readiness or acceptance. Stop the attempt at 15 minutes if no useful progress is possible and preserve the failed evidence.

| Stage | Action and evidence | Pass criterion | Diagnostic budget |
| --- | --- | --- | --- |
| Cold launch | Run the starter once; save its output and project/surface UUIDs. | One project with a persistent controller and distinct lead tab. No manual command pasting into a replacement tab. | 15 s to allocation |
| Native ready | Observe trust/account prompts and MCP startup; save job ready timestamp and native session identity. | The exact lead calls ready through MCP on the requested model. Any prompt remains visible and any required user action is reported. | 90 s from allocation, log prompt time separately |
| Warm restart | Rerun the same starter from a fresh process while the lead is idle. | Same lead ID, attempt, workspace and tab; no duplicate process or claim. Controller remains usable. | 10 s |
| Give the task | Enter the complete canary brief once in the lead tab. | Lead owns feature creation, private worker checkouts and assignments through the public CLI. | 60 s to first worker allocation |
| Native parallel work | Give independent UI and logic scope where useful; inspect named child-agent evidence. | Astra xhigh and Fable medium/Agent Teams remain enforced; each parent collects results and closes useful children. No concurrent writers share one checkout. | 5 min to worker results |
| Two-way mailbox | Require a worker to ask one concrete task question and the lead to reply through MCP. | Durable request and semantic reply IDs, from/to jobs and attempts agree. No manual mailbox forwarding. | 60 s per semantic reply |
| Ownership release | Save worker result, exit receipt, process identities and delivery receipt. | Result is durable, descendants stop, then a separate deterministic `job_stopped` notice wakes the assigned parent and references `result_message_id`. No early import race or duplicate durable notice. | 15 s from terminal report to released ownership; 60 s to lead action |
| Assembly and checks | Lead assembles worker commits, freezes the candidate and runs declared checks. | Exact candidate commit/tree/brief/requirements are recorded. Check logs prove behavior without mutating source. | 60 s for canary checks |
| Independent review | Launch a fresh opposite-runtime read-only reviewer; inspect the complete candidate and browser behavior. | Review payload names the current candidate and brief; current stopped evidence exists before import. Missing or interrupted reviewers block. | 5 min to completed review |
| Acceptance | Lead collects/imports review results and requests feature status through the public CLI. | `eligible: true`, no reasons, current checks and stopped review. No merge or deployment is implied. | 30 s after final review stops |
| Direct steering | Send a small scope correction to an idle lead, then observe its next assignment and brief. | Lead acknowledges the actual correction; changed candidate requires new current checks/reviews. The session remains available. | 60 s to acknowledgment |
| Controller lifetime | Inspect all tabs after workers/reviewers stop and after reopening the starter. | Owned controller survives; evidence tabs remain inspectable; focus changes do not redirect operations. | Check at each transition |
| Clean shutdown | Cancel remaining owned canary jobs through CLI; inspect exit evidence and process inventory. | All owned processes/children stop before claim reuse; unrelated tabs and source are preserved. | 15 s per job |

Perform these failure probes in separate disposable attempts after the happy path:

| Failure probe | Required outcome |
| --- | --- |
| Recipient not yet ready | Send remains durable and pending. Recipient reads it after ready. A wake receipt is never counted as a reply. |
| Unavailable/missing recipient tab | Delivery error is visible and durable message is retained. Recovery addresses the exact job and message. No resend loop or wrong-tab fallback. |
| Abrupt worker exit | An unexpected nonzero exit is failed even after a completion report; only an observed report-driven termination convention is accepted after complete cleanup proof. Process and descendant evidence controls release; the stopped notice includes failure details. Neither tab disappearance nor elapsed time proves stop. |
| Wrapper dies or inventory becomes unavailable | Health/status reports unresolved process ownership. A writer is not relaunched until actual stopped evidence or safe lifecycle recovery is established. |
| Interrupted replacement review | Existing approval cannot satisfy an active, failed, or cancelled new review attempt. Retry starts a fresh identity and requires a fresh result. |
| Candidate changes during review | Late approval is rejected; snapshot, checks and review must all bind the new candidate. |
| Native child impersonates parent | Child can initialize its required MCP connection but cannot send, report, or rebind as the parent. Source and model guards remain intact. |
| Model/trust/account block | Requested model and native safeguards remain enforced. Status identifies the block; there is no headless, silent model-switch or legacy-channel fallback. |

Use the public bounded commands and record their exact outputs:

```sh
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team status
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team job wait worker-1 --until ready --timeout-ms 30000
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team job wait worker-1 --until stopped --timeout-ms 30000
```

A wait observes one attempt; timeout leaves ownership unchanged. After feature collection is integrated, exercise its public command as part of the acceptance stage and save its exact `--help` output and result. An operator's custom polling or hand-written orchestration is an intervention, even if the task eventually succeeds. These tests do not introduce another orchestration script.

## Evidence and intervention log

Save a run directory outside source containing startup output, exact commands and timestamps, job/project records, attempt launch/exit/delivery receipts, the durable mailbox and message bodies, candidate identity, imported reviews, check logs, and focused native terminal/browser evidence. Redact credentials before sharing artifacts.

Record one CSV row per transition or intervention:

```text
run_id,harness_commit,leader,stage,started_at_utc,finished_at_utc,elapsed_ms,operator_wait_ms,job_id,attempt,workspace_id,surface_id,candidate_commit,evidence_path,outcome,intervention_kind,intervention_reason
```

Use `none`, `native_trust`, `native_login`, `native_approval`, `manual_wake`, `manual_forward`, `manual_tab_repair`, `manual_state_repair`, or `other` for intervention kind. Keep trust/login/approval prompts separate from harness repairs; do not bypass either category. Report cold and warm times individually, end-to-end elapsed time, number and duration of interventions, and the first failing stage. Do not subtract operator waits from the headline elapsed time.

The workflow is accepted only when both leadership directions complete with source-bound checks, current independent review, verified shutdown and no harness-repair interventions on the happy path. A native safeguard requiring input can be an expected pause, but must be recorded explicitly. A failed or unexecuted row remains a gap; deterministic integration results cannot fill it in.
