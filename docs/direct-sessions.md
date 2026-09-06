# Direct native sessions

Use this path for one bounded implementation, investigation, or independent review. Work in the target repository with your normal native CLI. You do not need to clone or install Agent Team Harness. cmux is optional for arranging terminals.

## Optional team skill

For a reusable workflow, [install the standalone team skill once](../README.md#invoke-the-team-skill) from a stable clone, then invoke it in your target project:

| App | Invocation |
| --- | --- |
| Claude Code | `/team <task>` |
| Codex desktop | Type `@team`, select the skill suggestion, then enter your task |
| Codex CLI | `$team <task>` |

Your current session remains the lead. The skill uses native agents for useful independent work, runs relevant checks, and gets a fresh read-only review of the candidate. It preserves your scope, model, effort, and native permissions. Start a new session if the installed skill is not visible.

A leading `cmux` selects [experimental coordination](cmux-team.md#start-a-team): `/team cmux` opens a team ready for a task; `/team cmux <task>` also hands off the task after readiness. In Codex desktop, select `@team` first, then enter `cmux` and an optional task; in Codex CLI, use `$team cmux`. Mentioning cmux elsewhere in an ordinary task keeps the native workflow.

## Implement

The following commands and prompts work directly without the skill. Start a native session in the intended checkout:

```sh
cd /absolute/path/to/your/repo
codex --model gpt-6-astra -c 'model_reasoning_effort="xhigh"'
```

Or use Claude Code:

```sh
cd /absolute/path/to/your/repo
claude --model 'claude-fable-5-1[1m]' --effort medium \
  --settings '{"switchModelsOnFlag":false}'
```

The examples retain Astra at xhigh and Fable at medium. Use an explicit model supported by your account. The settings override prevents Claude's automatic model switch; it does not change your native permission mode. Commands and flags were checked against installed Codex CLI 0.153.4 and Claude Code 2.1.263 on September 6, 2026. Consult `codex --help` or `claude --help` for your version. Native account, workspace-trust, sandbox, and approval controls still apply.

A useful task prompt:

> Implement [specific behavior] in this repository. Inspect the existing code and repository instructions first. Acceptance: [observable outcomes]. Keep the patch scoped and preserve unrelated work. Use native child agents only for independent assignments that help. Run the relevant checks and verify the changed user flow. Report files changed, verification, and remaining gaps.

One session owns each writable checkout. If independent assignments need simultaneous writers, give them separate Git worktrees and integrate their commits deliberately. The parent owns the scope, integration, verification, and cleanup of its native children.

## Review a fixed candidate

Commit the candidate and record its full SHA and the actual base revision. Start a fresh native session for review in that checkout or an isolated checkout of the candidate. Supply the requirements and both revisions; do not rely on another session's conversation history.

For a Codex review, the native read-only sandbox is available:

```sh
codex -C /absolute/path/to/candidate --sandbox read-only \
  --model gpt-6-astra -c 'model_reasoning_effort="xhigh"'
```

For a Claude Code review, start a fresh session and use the file-reading tool set when only source inspection is needed:

```sh
cd /absolute/path/to/candidate
claude --model 'claude-fable-5-1[1m]' --effort medium \
  --settings '{"switchModelsOnFlag":false}' --tools 'Read,Glob,Grep' \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
```

Save a patch with `git diff <actual-base> <candidate-sha> -- > /absolute/path/to/candidate/review.patch` before starting a file-only reviewer, and give it that path alongside the candidate source. A file-only review cannot execute checks; run those separately and provide their results. The empty strict MCP configuration also disables configured external tools for this review session.

A useful review prompt:

> Review candidate [full SHA] against base [full SHA] and these requirements: [requirements]. Inspect the complete diff at [path] and the relevant candidate source. Do not edit files. Report substantiated correctness or regression issues with file, line, trigger, impact, and a concrete fix. Distinguish required fixes from optional suggestions. If there are no required findings, say so. State what you could not verify.

The implementer evaluates the findings, batches justified repairs, and reruns affected checks. A changed candidate needs review of the changed source. A review verdict is evidence for the operator's decision; it does not merge or deploy anything.

## When to try coordination

Use the [experimental cmux workflow](cmux-team.md) when a task has substantial independent assignments and shared ownership, messaging, or collection is worth the extra coordination. Existing native subagents remain the first option for work within a session.

The [September 6 trial](native-workflow-findings.md) did not meet its small-task efficiency target. A faster allocation time or more active agents does not prove faster useful completion. Compare equivalent requirements and checks, recording total elapsed time and operator interventions before claiming an advantage.
