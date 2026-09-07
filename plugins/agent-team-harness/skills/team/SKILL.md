---
name: team
description: Run a visible coding team in Herdr with approved task-based builders, parallel native subagents, lead review, and an optional separate adversarial check. Use when the user invokes team or asks for this Herdr workflow.
---

# Team

Use the user's task and constraints. The invoking native Claude Code or Codex session remains lead. Preserve model, effort, permissions, and planning-only or review-only scope. Herdr owns terminals and agent control; the lead owns assignments, review, integration, and final verification.

## Start in the right project

Before control commands, verify `HERDR_ENV=1`. Outside Herdr, explain that this workflow starts in a native agent inside the intended project's Herdr workspace; do not spoof the environment or operate another client's focused session.

Read `herdr --skill` once for the installed version's control instructions. Use its CLI guidance without copying or maintaining a second command manual.

Resolve the intended repository and inspect its instructions and current changes. Use one workspace for that project. If the invoking workspace belongs to another project, resolve that mismatch before launching workers. Reuse the current lead and suitable agents already assigned to this project; inspect live state before creating replacements. A bare invocation prepares the workspace and waits for a task without inventing implementation work.

## Confirm the team and make work visible

Use separate named tabs for **Lead**, **Build**, and, only if approved, **Adversarial**. Either Codex or Claude Code can lead. Recommend Fable through Claude Code for frontend work and Codex for backend work. For a mixed task, explain whether one builder or separate frontend/backend assignments fit better. These are recommendations, not automatic assignments.

Before launching or dispatching workers for a task, show the recommended builder/model and scope, ask Andrew to approve or change it, and explicitly ask whether he wants a separate adversarial check. Offer the proposed adversarial runtime as part of that choice. If declined, omit the role and dedicated adversarial work; lead review and normal verification still apply. Verify proposed models are available; do not silently substitute. Preserve native effort and permissions unless the user chooses otherwise. Existing approval covers the same task and lineup, including routine follow-ups and retries; ask again for a material change.

The lead always performs the review. When requested, the adversarial role must be a separate native agent with fresh context, never the lead or the implementation author. It challenges assumptions, failure cases, and missed requirements; it does not replace the lead's judgment or implement the candidate. Do not assume its model must differ from the lead's unless the user requests that.

Use returned workspace/tab/pane IDs and unique live agent names scoped to this workspace. Keep background creation unfocused. Start agents in available shell panes and inspect their actual startup UI before calling them ready. Resolve routine choices under existing authorization; report login or permission decisions that need the user.

Give simultaneous writers separate Git worktrees with disjoint assignments. Create each worker tab with its worktree as cwd. Give an approved adversarial agent a separate checkout of the actual candidate. For non-Git work, use separate copies or one writer. Keep the main roles visible in Herdr; their native subagents may be visible only inside the parent CLI. Do not represent each internal subagent as a separate Herdr Agents entry.

## Favor useful parallelism

Speed matters. Encourage both Claude and Codex, including the lead, to use as many useful native subagents as their configured limits allow for independent parts of their respective assignments. Keep the critical path with the parent; parallelize investigation, distinct implementation scopes, and relevant checks without duplicating work or creating needless coordination. Give every child a bounded objective, context, write scope, and completion criteria; isolate simultaneous writers. Stay within approved scope and model choices. Individual native children do not require another approval, but they must not be used to perform a declined adversarial check. Parents collect results, review and verify them, and close their children when done.

## Delegate and collect

Each assignment states the objective, absolute working directory, write scope, relevant requirements, completion evidence, and permission to use useful native subagents. Tell workers to finish, collect their children's results, report changed files and checks, then wait. They do not re-invoke this team skill or create additional top-level Herdr teams. Use `herdr agent prompt` to submit work and bounded waits of at most 30 seconds so the lead remains responsive.

Read actual replies and inspect the resulting source or artifacts. `idle` and `done` are terminal lifecycle states, not proof of task completion. A repeated request matching work already running means observing that assignment without re-prompting or interrupting its worker. A wait timeout or ambiguous result is a reason to inspect, not resend the assignment or start another writer. Use the upstream skill's file-output fallback only when terminal history cannot provide the result.

## Steering and pauses

Route new requirements through the lead. Send each approved affected worker a concise update and update the review and adversarial criteria. Preserve work already completed; do not restart the task merely because requirements changed. Apply the dispatch approval rule if the change needs a different builder or materially different scope.

If a worker shows an unexplained interruption or the user reports pressing Esc, hold that assignment and report it. Do not automatically continue it, transfer it to another writer, or send another prompt until the user resumes it. An interruption deliberately initiated by the lead for an authorized update may be resumed by that lead.

On **pause team**, stop dispatching work and have each parent hold or stop its native children. Interrupt non-lead workers that are running or awaiting approval through documented Herdr controls; never approve a tool solely to pause it. Inspect and report what stopped and what remains active, blocked, or unverified, including children. A parent appearing idle does not prove its children stopped. Resume only on the user's explicit instruction after inspecting existing work and live identities. Keep pause intent in any handoff. Esc affects a native agent; this is a behavioral convention, not an enforced global stop or a guarantee that background processes exited.

## Review and finish

The lead personally reviews the latest requirements, actual base, complete candidate diff, and source. If the user approved the adversarial check, give that separate agent the same materials and ask it to challenge the implementation and lead's assessment with concrete evidence, not a required number of findings. The lead evaluates its findings and owns the final decision. Review-only work ends with findings. For implementation work, have the approved builder repair justified issues, rerun affected checks, review changed source, and recheck any affected adversarial concerns. Do not invent findings to exercise a repair loop.

Verify relevant behavior, including a real browser for a user-facing UI when available. Do not repeat passed checks without a change or unresolved concern. Report the result, artifact paths, checks, lead review, adversarial findings and their disposition, and remaining limitations. Commit, merge, and publication authority comes from the user's task.

Leave the team's tabs available and agents idle for inspection. Stop only temporary processes this task owns, using their specific handles or verified PIDs. After a resume or restart, rediscover agents and inspect Git/work before issuing commands; never replay completed assignments based only on old names or sidebar state.
