# Experimental native cmux operation

Use the repository's public native starter and `team` CLI. This mode has no receiver daemon or channel bridge. Find the actual harness checkout and target project; do not infer either from a different task.

From a terminal inside cmux:

```sh
node /absolute/harness/scripts/start-team.js --project /absolute/target/repo
```

Use `--leader claude` for a Claude lead. The starter prints the coordinator path, lead job ID, and health. To hand off a task, write its exact text to UTF-8 and add `--task-file /absolute/task.txt`, optionally `--task-id a-stable-id`. The starter persists it before launch and returns its record path; verify the lead's semantic acknowledgment there. Retry the same ID/content without pasting another task into the terminal. A stopped recipient requires explicit `--resume-task` after inspecting prior progress; completed tasks are not replayed. Repeating it inspects the active attempt. Inspect native trust, login, or approval prompts when blocked; do not silently switch models or workflows. Keep the user's normal native permission policy.

The default cap is four harness jobs including the lead. Native child agents belong to their parent and are not included in this cap. Split substantial independent assignments; more agents are not an acceptance criterion. Each simultaneous writer needs a separate checkout.

Use the printed coordinator for commands:

```sh
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team status
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team job list
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team job read <job-id>
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team job wait <job-id> --until stopped --timeout-ms 30000
node /absolute/harness/agent-team/src/cli.js --cwd /absolute/coordinator team job cancel <job-id>
```

Give each job its concrete scope and assigned parent. The launcher supplies local MCP tools bound to that job and attempt: `team_report`, `team_send`, `team_inbox`, and `team_reply`. Children use their native parent messaging, not the parent's harness identity. Only the parent returns a synthesized result to the harness.

A terminal report stores the semantic result. The runner stops the native child and observed descendants, records cleanup, and sends a separate stopped-job notice to the assigned parent attempt. Wait for that evidence before reusing a checkout or importing a review. Cancellation requests shutdown; it does not itself release ownership. Never clear claims because a tab disappeared.

For feature work, read `docs/cmux-team.md` in the actual harness checkout for the current job/feature JSON and assembly, snapshot, check, review-import, and status commands. Use the complete committed candidate for an independent review. Its exact required reviews and checks must pass before acceptance; eligibility does not merge or deploy.

Launch and wake commands must remain inside cmux's native socket policy. Stop workers before their lead. Retain failed evidence and disclose the first failing stage instead of adding an orchestration loop to hide it.
