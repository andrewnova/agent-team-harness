# Direct native sessions

Use this path for one bounded implementation, investigation, or independent review. Work in the target repository with your normal native CLI. You do not need to clone or install Agent Team Harness.

## Optional team skill

For the current team workflow, follow the [Herdr setup](../README.md#quickstart) and [native invocation examples](../README.md#invoke-the-team-skill). It starts in Codex or Claude Code inside the intended project's Herdr workspace. Your invoking session remains lead, asks you to approve builders and choose whether to add a separate adversarial check, and always reviews the result. The standalone commands below do not invoke that skill.

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

Use native subagents for independent work within one session. When you want visible lead and builder roles, use the [Herdr team workflow](../README.md#invoke-the-team-skill), with separate worktrees for simultaneous writers and optional adversarial review. See its [validation boundary](../README.md#why-this-is-the-default) before drawing performance conclusions.

The [historical cmux guide](cmux-team.md) and [September 6 trial findings](native-workflow-findings.md) remain available for existing harness users.
