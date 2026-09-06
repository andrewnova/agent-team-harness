---
name: team
description: Run a requested team coding workflow in the current Claude Code or Codex session, using native agents for independent work and a fresh review. Use when the user invokes team or asks for this workflow.
---

# Team

Use the task and constraints in the invoking message. A leading `cmux` after the skill name selects the coordinated mode below: `team cmux` opens a team ready for a task; `team cmux <task>` also hands off that task. Otherwise use the native workflow. Mentioning cmux as the subject of an ordinary coding task does not select coordinated mode.

Preserve the user's model, effort, permission settings, and requested scope, including review-only or planning-only work. In native mode, keep the current session as lead; if no task or active objective is available, ask for the task before launching agents.

## Native workflow

1. Inspect the intended repository and its instructions. Identify the requested behavior and the checks that would demonstrate it.
2. Keep the critical path with the lead. Delegate bounded, independent assignments through this runtime's native agent tools when that improves completion. Give each agent its scope, context, and completion criteria. Avoid duplicate assignments; a small task may need only the lead and a reviewer.
3. Give simultaneous writers separate checkouts or worktrees. The lead integrates their results and owns verification and child cleanup. Do not create a new harness coordinator, receiver daemon, or MCP configuration for this workflow.
4. Run the relevant checks. Give a fresh read-only reviewer the requirements, actual base, complete candidate diff, and source access. Use a native child with independent context or a fresh native session; keep the same runtime unless the user requests another. Review-only requests can go directly to this step. Do not create a second implementation writer for review.
5. Evaluate findings, make justified repairs within scope, and rerun affected checks. Changed source needs corresponding review. A planning-only task should receive review of its plan, without implementation. Stop or close your children and report the result, verification, and material gaps.

Keep review tied to the delivered candidate. Commit, merge, publish, and external-service authority comes from the user's request, not from invoking this skill. If a fresh reviewer is unavailable, disclose that gap; do not describe self-review as independent.

## Explicit cmux coordination

If the user requests the experimental coordinated cmux workflow, read the packaged [native cmux guide](../agent-team-harness/references/native-cmux.md) instead. Resolve that reference from this skill's real source location when it is symlink-installed. Use the actual harness checkout and target repository. Native sessions remain the default; do not start the legacy daemon as a fallback.

- Resolve the target from the current project or the user's explicit path. `team cmux` alone authorizes startup, without inventing implementation work. Select the current native runtime as lead unless the user chooses another.
- Run the guide's starter from a terminal inside cmux. From a desktop session outside cmux, use available authorized native computer control to open cmux and a terminal for this launch, then run the starter there. If that control is unavailable, give the exact command to run in a cmux terminal. Do not spoof cmux environment variables or weaken its socket policy.
- Inspect the returned coordinator, job, and health. Reuse the existing lead when reported; wait for native readiness and inspect blocking login or trust prompts before claiming activation. If a task was supplied, enter it once into that exact lead's native terminal after it is ready and confirm its acknowledgment. Do not impersonate a harness job to send the user's task. Without a supplied task, leave the ready lead waiting for the user.
