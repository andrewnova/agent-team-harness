---
name: team
description: Run a requested team coding workflow in the current Claude Code or Codex session, using native agents for independent work and a fresh review. Use when the user invokes team or asks for this workflow.
---

# Team

Use the task and constraints in the invoking message. If no task or active objective is available, ask for the task before launching agents. Keep the current native session as lead and preserve the user's model, effort, permission settings, and requested scope, including review-only or planning-only work.

## Native workflow

1. Inspect the intended repository and its instructions. Identify the requested behavior and the checks that would demonstrate it.
2. Keep the critical path with the lead. Delegate bounded, independent assignments through this runtime's native agent tools when that improves completion. Give each agent its scope, context, and completion criteria. Avoid duplicate assignments; a small task may need only the lead and a reviewer.
3. Give simultaneous writers separate checkouts or worktrees. The lead integrates their results and owns verification and child cleanup. Do not create a new harness coordinator, receiver daemon, or MCP configuration for this workflow.
4. Run the relevant checks. Give a fresh read-only reviewer the requirements, actual base, complete candidate diff, and source access. Use a native child with independent context or a fresh native session; keep the same runtime unless the user requests another. Review-only requests can go directly to this step. Do not create a second implementation writer for review.
5. Evaluate findings, make justified repairs within scope, and rerun affected checks. Changed source needs corresponding review. A planning-only task should receive review of its plan, without implementation. Stop or close your children and report the result, verification, and material gaps.

Keep review tied to the delivered candidate. Commit, merge, publish, and external-service authority comes from the user's request, not from invoking this skill. If a fresh reviewer is unavailable, disclose that gap; do not describe self-review as independent.

## Explicit cmux coordination

If the user requests the experimental coordinated cmux workflow, read the packaged [native cmux guide](../agent-team-harness/references/native-cmux.md) instead. Resolve that reference from this skill's real source location when it is symlink-installed. Use the actual harness checkout and target repository. Native sessions remain the default; do not start the legacy daemon as a fallback.
