# Native teams in cmux

`agent-team team` runs parallel native Codex and Claude Code sessions inside one cmux project. It reuses the harness mailbox and local state without starting the legacy daemon. A lead owns the brief, assignments, repair decisions, and acceptance.

## Start a team

Install cmux, Git, Node.js >=22.13.0, Codex CLI >=0.153.4, and Claude Code >=2.1.263 on macOS; those are the native CLI versions verified with this workflow. Sign in to both coding CLIs and confirm account access to the chosen models. From a terminal inside cmux, in this harness clone:

```sh
node scripts/start-team.js --project /absolute/path/to/your/repo
```

The target must be an existing Git repository. The starter opens `Team · your-project` with an Astra lead; once it reports ready, give it a task. Append `--leader claude` for a Fable lead. The lead creates worker and reviewer tabs through the CLI as work becomes ready, with four active jobs including itself by default. Child agents inside a job do not count toward that cap. There is no automatic scheduler.

Startup prints a coordinator path and lead job ID. State defaults to `~/.local/state/agent-team/cmux/<project-id>`; use `--coordinator /absolute/path` for another location. The coordinator must be separate from the target checkout. The starter gives it an isolated local Git root so the writable lead cannot claim an enclosing project by accident. Source implementation belongs in separate feature and worker worktrees.

The same startup command reports an existing active lead instead of opening another one. To change its startup configuration, finish or cancel the existing jobs first. A stopped lead may be replaced only after its workers have finished or stopped. Existing messages stay addressed to their original job and attempt.

Startup reports `starting`, `ready`, `stopping`, or `blocked` from durable readiness and the addressed terminal. A missing controller is replaced only after cmux confirms its absence in the saved workspace. Unknown allocation outcomes remain reserved; known returned UUIDs can be verified and adopted on retry. A blocked startup exits unsuccessfully and includes the reason.

Use `--max-active`, `--codex-bin`, `--claude-bin`, `--codex-model`, and `--claude-model` to select capacity, executable paths and model IDs explicitly. `node scripts/start-team.js --help` lists the options. For example, when a shell wrapper selects an unintended CLI:

```sh
node scripts/start-team.js --project /absolute/path/to/your/repo \
  --codex-bin "$HOME/.local/bin/codex" \
  --claude-bin "$HOME/.local/bin/claude"
```

This startup path does not install global skills or MCP configuration. Each native session receives the team tools and its assignment directly. Login, trust, and approval prompts stay visible in its terminal. The model defaults below describe the intended routing; your accounts must support the specified IDs.

| Assignment | Runtime and model |
| --- | --- |
| Backend implementation and repairs | Codex with Astra |
| Frontend implementation and repairs | Claude Code with Fable |
| Review when Astra leads | Fresh Fable reviewer sessions |
| Review when Fable leads | Fresh Astra reviewer sessions |

Model IDs are explicit in job JSON. The runtime never silently substitutes a model. Claude launches set `switchModelsOnFlag: false` through per-session `--settings` (verified against Claude Code 2.1.263), preserving native safeguard pauses instead of automatic model switching. A paused or switched reviewer has not completed the assigned review; keep the result unaccepted and inspect the native session. Global settings are unchanged. See [Claude's model-switch behavior](https://support.claude.com/en/articles/15363606-why-claude-switched-models-in-your-conversation-with-fable-5-or-fable-5-1). A reviewer is a separate job from implementation, even when the reviewer model also implemented another part of the feature.

## Child agents inside a job

Each job may run child agents through its native CLI. The defaults are versioned in `agent-team/native-team.config.json` and applied per launch; global Codex and Claude settings are not edited.

- Codex jobs launch Astra at `xhigh` effort with native `multi_agent_v2` enabled; `xhigh` is applied to the parent and as the default for child and role agents.
- Claude Code jobs launch Fable at medium effort with [Agent Teams](https://code.claude.com/docs/en/agent-teams) enabled (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), teammates in-process, and [every descendant pinned to the parent's explicit model](https://code.claude.com/docs/en/sub-agents#run-every-subagent-on-one-model) (`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`). Agent Teams need Claude Code 2.1.263, the verified version; the pinned child model itself needs 2.1.257 or later.

These are configured launch settings. The harness does not detect or undo manual changes made inside a running session.

Coding and review jobs should launch as many child agents as the independent work justifies, within native CLI and account limits. Workers split independent responsibilities, refill useful capacity, and avoid duplicate work. Reviewers fan out across independent risk areas of the frozen candidate, collect every child result, synthesize one verdict, and stop their children. The parent job owns child scopes, private worktrees for simultaneous writers, the permission boundary, results, and shutdown. Children return results to their parent by native messages; only the parent uses the harness team tools and reports one result. Read-only reviewers can use child agents and messages, but their children cannot edit source. The harness neither schedules nor caps native children; `--max-active` counts harness jobs only, lead included.

## Start jobs

Use a coordinator directory outside the source being reviewed. One coordinator uses one cmux project in the left sidebar; every agent receives its own horizontal tab inside it. Run launch and wake commands from a terminal inside cmux; its descendant-only socket policy stays in force. Native workspace-trust and login prompts remain visible.

```sh
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team project create --title "Agent Team Harness"
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team job create --json /absolute/backend-job.json
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team job launch backend-1 --max-active 4 --codex-bin /absolute/codex --claude-bin /absolute/claude
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team job list
```

The first launch creates this shared project if it does not exist. To use an existing owned project, call `team project attach --workspace <uuid> --surface <controller-terminal-uuid>` instead. Job tabs are created beside that anchor, with explicit workspace and surface addressing. The launcher preserves the project's other tabs.

Example assignment:

```json
{
  "id": "backend-1",
  "feature_id": "example-feature",
  "parent_job": "lead-1",
  "leader": "codex",
  "role": "backend",
  "model": "gpt-6-astra",
  "cwd": "/absolute/backend-worktree",
  "writable": true,
  "prompt": "Implement the API in src/api only. Report the commit, focused checks, and remaining issues to lead-1.",
  "dependencies": []
}
```

Create a `lead` job with the same `leader`, its chosen model, and a coordinator assignment. Keep it active while workers and reviewers return results. For a Fable reviewer use `role: "review"`, `leader: "codex"`, `writable: false`, its explicit Fable model ID, the feature worktree, and the required reviewer ID. For an Astra reviewer use `leader: "claude"` and its Astra model ID. Model availability is account-specific.

`parent_job` names the lead that receives the final result and process-exit notice. If omitted, a new worker or reviewer inherits the single active matching lead. The parent attempt is fixed when the worker launches; a replacement lead never receives an old attempt's notification by accident.

The lead launches ready independent jobs up to its configured `--max-active` cap and refills slots as jobs finish. Dependencies must already exist and finish successfully. Each simultaneous writer needs a private checkout; aliases and subdirectories of one checkout share the same writer claim. This command does not create a scheduler; child agents inside a job are governed by the native CLI, not by this cap.

Use absolute executable overrides when a shell or cmux wrapper shadows the intended CLI. All launches remain interactive. Codex uses its requested sandbox and normal approval policy. Read-only Claude jobs expose file-reading tools, native agent and messaging tools, and the launch-bound team MCP tools; source-editing tools are unavailable, and child agents inherit the same boundary. Unapproved operations are denied.

## How the agents talk

Both CLIs receive the same local stdio MCP server, bound to a job ID and attempt. Claude's per-session server configuration sets [`alwaysLoad: true`](https://code.claude.com/docs/en/mcp#exempt-a-server-from-deferral), so the four communication tools are available at startup even in read-only sessions without tool search:

- `team_report({status: "ready"})` confirms agent readiness. Allocating a pane alone does not.
- `team_send({to_job, body})` appends a durable message to the existing mailbox.
- `team_inbox({})` reads only the current addressed inbox.
- `team_reply({in_reply_to, body})` replies to the original sender and attempt.

After a send, the MCP process submits a short cmux wake to the recipient's recorded workspace and terminal UUIDs. The wake asks the recipient to read its inbox. The mailbox contains the actual message; terminal activity and a successful wake are not semantic replies. If the recipient is not ready, delivery stays pending and its startup instructions tell it to read its inbox. A failed wake preserves the sent message and returns the delivery error; retry the wake, not the send:

```sh
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team job wake reviewer-1 --message jobmsg_example
```

Operators can use `job read`, `job inbox`, and `job show` to inspect an exact job. Direct typing in its cmux terminal remains available for steering. A scope change belongs in the lead's assignment and subsequent review brief.

## Assemble, freeze, review, repair

Create one feature worktree before dispatching implementation. Example feature JSON:

```json
{
  "id": "example-feature",
  "repo": "/absolute/repository",
  "cwd": "/absolute/feature-worktree",
  "branch": "codex/example-feature",
  "base": "main",
  "brief": "The requested behavior and acceptance criteria.",
  "leader": "codex",
  "review_jobs": ["reviewer-1", "reviewer-2"],
  "checks": [{"id": "unit", "command": ["npm", "test"], "timeout_ms": 180000}]
}
```

```sh
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team feature create --json /absolute/feature.json
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team feature assemble example-feature --json /absolute/assembly.json
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team feature snapshot example-feature
```

Assembly JSON contains the full worker `commit`, `worker_cwd`, and explicit `allowed_paths` (plus optional `forbidden_paths`). Assembly validates the shared repository, ancestry, and changed paths before cherry-picking one commit. Conflicts remain visible. Importing a worker commit does not approve it.

A snapshot requires a clean committed feature, including untracked files. Launch the required read-only review jobs concurrently with required checks. Reviewer startup includes the brief, exact candidate, complete integrated diff, previous findings, and the expected result shape. At least one assignment should cover the complete flow and shared interfaces. Other features can build while this feature is reviewed.

```sh
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team feature check example-feature
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team feature import-review example-feature --job reviewer-1
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team feature import-review example-feature --job reviewer-2
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team feature status example-feature
```

Checks run on an isolated detached checkout of the candidate and retain logs outside source. Declared commands must prepare their own dependencies and isolated ports, databases, and profiles. A timeout retains the scratch directory for inspection because children may still be writing. This implementation runs a feature's declared checks serially inside that isolated run; run the check command alongside the independent reviewers.

Reviewers return `team_report` with a terminal status, an addressed recipient, and a JSON string in `result`: `candidate`, `brief_hash`, `verdict`, and `findings`. Each finding has a stable `id`, explicit `required`, source `evidence`, and `status`. Resolving or rejecting a finding requires `resolution_evidence`.

Collect the complete review round, then batch independent repairs. Commit and snapshot the repairs, relaunch each required review job, rerun checks, and import current results. Relaunching a stopped reviewer starts a new native session and attempt; its startup packet retains prior findings. Old approvals do not satisfy a new candidate or a pending replacement attempt. `feature status` exits unsuccessfully unless every required current reviewer and check passes and all required findings are resolved.

Eligibility means ready for target integration. It does not merge, publish, or deploy anything.

## Stop and diagnose

`team_report` stores a semantic result. The supervising wrapper stops the native process and observed descendants, releases ownership, then sends the assigned lead a durable `job_stopped` notification referencing that result. A crash without a semantic result also produces a stopped-job notice. Repeating collection does not duplicate the notice. This ordering lets the lead act on one completion wake without racing process cleanup. Agents must not deliberately daemonize or launch work that outlives their assignment.

`job cancel <id>` requests termination; it does not itself declare the process stopped. The owned terminal stays available for inspection after exit. Local launch, failure, and exit receipts live under `.agent-team/sessions/<job>/<attempt>/`; job records retain previous attempts.

Use the public status and bounded waits instead of a custom polling script:

```sh
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team status
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team job wait backend-1 --until ready --timeout-ms 30000
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team job wait backend-1 --until stopped --timeout-ms 30000
```

A wait observes one attempt and leaves the job unchanged when it times out. Startup without readiness becomes visibly blocked after two minutes; inspect the native prompt or startup error before deciding to retry. Validation failures before native allocation release their unused claim. Uncertain native allocations retain it. The wrapper claims each attempt once, handles cancellation before spawn, and records failures during launch and cleanup.

Uncertain allocation, lost surface identity, unobservable descendants, stale results, and locked/corrupt state fail visibly. Never clear a writer claim solely because a pane disappeared. Inspect and stop the exact owned processes before repairing coordinator state or retrying a job. Native session IDs are recorded when provided by the runtime; cmux UUIDs, process identity, and attempts always govern addressing.

## Validation boundary

Hermetic tests cover routing, concurrent ownership, attempt fencing, addressed MCP messages, launch failures, source-bound review/check evidence, and CLI behavior. Live proof must separately establish model availability, native readiness, the two-way semantic exchange, direct steering, child-agent behavior inside a job, and shutdown on the installed CLIs. Successful unit tests do not establish those live properties.
