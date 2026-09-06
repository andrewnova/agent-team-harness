# Native teams in cmux

`agent-team team` is an opt-in workflow for parallel native Codex and Claude Code sessions. It reuses the harness mailbox and local state without starting the legacy daemon. A lead owns the brief, assignments, repair decisions, and acceptance.

| Assignment | Runtime and model |
| --- | --- |
| Backend implementation and repairs | Codex with Astra |
| Frontend implementation and repairs | Claude Code with Fable |
| Review when Astra leads | Fresh Fable reviewer sessions |
| Review when Fable leads | Fresh Astra reviewer sessions |

Model IDs are explicit in job JSON. The runtime never silently substitutes a model. Claude launches set `switchModelsOnFlag: false` through per-session `--settings` (verified against Claude Code 2.1.263), preserving native safeguard pauses instead of automatic model switching. A paused or switched reviewer has not completed the assigned review; keep the result unaccepted and inspect the native session. Global settings are unchanged. See [Claude's model-switch behavior](https://support.claude.com/en/articles/15363606-why-claude-switched-models-in-your-conversation-with-fable-5-or-fable-5-1). A reviewer is a separate job from implementation, even when the reviewer model also implemented another part of the feature.

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

The lead launches ready independent jobs up to its configured `--max-active` cap and refills slots as jobs finish. Dependencies must already exist and finish successfully. Each simultaneous writer needs a private checkout; aliases and subdirectories of one checkout share the same writer claim. This command does not create a scheduler or nested agent teams.

Use absolute executable overrides when a shell or cmux wrapper shadows the intended CLI. All launches remain interactive. Codex uses its requested sandbox and normal approval policy. Read-only Claude jobs expose file-reading tools and the launch-bound team MCP tools; source-editing and nested-agent tools are unavailable. Unapproved operations are denied.

## How the agents talk

Both CLIs receive the same local stdio MCP server, bound to a job ID and attempt:

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

`team_report` reports a semantic result. The supervising wrapper subsequently stops the native process and observed descendants before releasing its capacity and checkout claim. It tracks tool servers that create separate process groups. Agents must not deliberately daemonize or launch work that outlives their assignment.

`job cancel <id>` requests termination; it does not itself declare the process stopped. The owned terminal stays available for inspection after exit. Local launch, failure, and exit receipts live under `.agent-team/sessions/<job>/<attempt>/`; job records retain previous attempts.

Uncertain allocation, lost surface identity, unobservable descendants, stale results, and locked/corrupt state fail visibly. Never clear a writer claim solely because a pane disappeared. Inspect and stop the exact owned processes before repairing coordinator state or retrying a job. Native session IDs are recorded when provided by the runtime; cmux UUIDs, process identity, and attempts always govern addressing.

## Validation boundary

Hermetic tests cover routing, concurrent ownership, attempt fencing, addressed MCP messages, launch failures, source-bound review/check evidence, and CLI behavior. Live proof must separately establish model availability, native readiness, the two-way semantic exchange, direct steering, and shutdown on the installed CLIs. Successful unit tests do not establish those live properties.
