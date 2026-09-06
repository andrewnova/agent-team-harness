---
name: agent-team-harness
description: Operate explicitly requested Agent Team Harness workflows or resume existing .agent-team jobs. Use for native cmux team coordination and legacy daemon operation; ordinary Claude Code or Codex coding and review should use direct native sessions.
---

# Agent Team Harness

Choose the workflow from the user's request and the existing project state. A request for frontend work, a second opinion, a review, or Claude's thoughts does not by itself request this harness.

## Direct sessions are the default

For a bounded task, use the selected native Codex or Claude Code session in the target checkout. Give it the actual requirements and scope, then verify its result. Use native child agents for useful independent work. Do not create harness state or start a receiver daemon for this path. Preserve the user's explicit model and native permission settings.

## Explicit native teams

Use [native cmux operation](references/native-cmux.md) when the user requests coordinated harness jobs in cmux or continues an existing native team. This path is experimental. A twenty-minute small-task trial did not reach acceptance; successful component tests do not prove a throughput gain.

## Existing legacy operation

Read [legacy daemon operation](references/legacy-daemon.md) only when the user explicitly requests the older daemon/channel workflow or is resuming its existing tasks. Its mailbox and transport rules apply within that workflow. Do not load or start it as a fallback for a blocked native session.

## Shared ownership and evidence

Keep concurrent writers in separate checkouts. The native parent owns its child assignments, integration, and shutdown. For harness jobs, retain ownership until recorded process cleanup is proven. A sent wake is not a reply; a semantic report is not proof that the native processes stopped. Bind review and checks to the actual candidate. Respect the user's existing authority for commits, external actions, and merge or deployment.
