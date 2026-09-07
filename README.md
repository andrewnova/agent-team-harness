# Team for Herdr

<img src="site/assets/logo.svg" alt="Team for Herdr logo" width="72">

**Run a native Codex or Claude Code team inside Herdr.**

The `team` skill keeps your invoking session as lead, proposes builders for your task, and keeps the main roles visible in Herdr. The lead always reviews the result; a separate adversarial check is optional. This is a one-file workflow built on Herdr's official `herdr --skill` instructions. No custom coordinator is required.

[Website](https://andrewnova.github.io/agent-team-harness/) · [Quickstart](#quickstart) · [Invoke the team skill](#invoke-the-team-skill) · [Direct-session guide](docs/direct-sessions.md) · [Historical cmux guide](docs/cmux-team.md)

## Quickstart

Install [Herdr using its official instructions](https://herdr.dev/docs/install/). Have Git, Bash, and the native Codex or Claude Code CLI installed and signed in, with access to the models you want to use. Install both CLIs if your approved lineup will use both. The skill setup requires only Bash and Git; it has no Node.js runtime requirement.

Clone this repository into a location you will keep, then install the skill:

```sh
git clone https://github.com/andrewnova/agent-team-harness.git
cd agent-team-harness
./scripts/install-team-skill.sh
```

The installer installs only `team`, linking the shared skill source into Codex and Claude Code through symlinks. Keep this clone at its installed location. It installs no CLI wrapper, daemon, or MCP configuration.

For an existing clone, inspect `git status --short` and update with `git pull --ff-only` when the checkout is clean. If the installer finds a different existing `team` skill, refresh it explicitly:

```sh
./scripts/install-team-skill.sh --refresh
```

Refresh preserves the replaced files or links as backups and links to this clone. Start a new native session if the skill is not visible yet.

### Optional session restore

For the CLIs you use, install Herdr's optional integrations:

```sh
herdr integration install claude
herdr integration install codex
herdr integration status
```

These integrations add native `SessionStart` hooks that report session identity for eligible conversation recovery after a Herdr server restart. Start fresh native sessions after installing the hooks. Claude Code and Codex activity still comes from Herdr's screen detection. They are separate from the skill installer and do not provide a global stop. See the official [integration instructions](https://herdr.dev/docs/integrations/) and [session restore requirements](https://herdr.dev/docs/session-state/).

## Invoke the team skill

Open a terminal in the project you want to work on and start Herdr:

```sh
cd /absolute/path/to/your/repo
herdr
```

If Herdr attaches to an existing session, select or create the workspace for your project. In a **shell pane inside that workspace**, confirm the project directory and launch your lead:

```sh
codex
```

Or run `claude` in that pane. Complete any native login or workspace prompts, then enter the task at the agent's prompt:

| Native CLI inside Herdr | Example invocation |
| --- | --- |
| Codex | `$team Add a settings page with notification preferences. Verify that saving and reloading preserves the selection.` |
| Claude Code | `/team Add a settings page with notification preferences. Verify that saving and reloading preserves the selection.` |

Your invoking Codex or Claude Code session remains **Lead**, preserving its model, effort, permissions, and task scope. A bare `$team` or `/team` prepares the workspace and waits for your task.

The workflow starts only in a native agent inside Herdr, where `HERDR_ENV=1` is inherited from the pane. Invoking it in Codex desktop or another session outside Herdr explains this entry requirement; it does not bootstrap or control a Herdr workspace from there. The lead reads the installed version's `herdr --skill` for control commands. See Herdr's [official skill documentation](https://herdr.dev/docs/agent-skill/) and the [shipped team skill](plugins/agent-team-harness/skills/team/SKILL.md).

### Before workers start

The lead inspects your project and proposes the builder runtime, model, and assignment for your approval. It recommends Fable through Claude Code for frontend work and Codex for backend work. For mixed work, it explains whether one builder or separate frontend/backend assignments fit. It checks model availability, never silently substitutes, and asks you to approve or change the proposal before launching or dispatching workers.

At the same time, the lead explicitly asks whether you want an **Adversarial** check and proposes its runtime. If approved, that role is a separate native agent with fresh context, distinct from both the lead and the implementation author. Its model may match the lead's. If declined, that role is omitted; the lead still reviews and verifies the work. Approval covers routine follow-ups and retries for the same task and lineup; a material change needs a new decision.

### Working with the team

- **Visible roles:** Lead, Build, and the approved Adversarial role use named Herdr tabs. Simultaneous writers get separate Git worktrees and disjoint assignments; an adversarial agent gets a separate checkout of the actual candidate.
- **Useful parallelism:** The lead and builders are encouraged to use as many useful native children as their configured limits allow, with bounded scopes and isolated writers. Parents collect, review, verify, and close their children. Children may appear only inside the parent CLI, rather than as separate Herdr tabs or Agents entries. They do not require individual approval or override a declined adversarial check.
- **Steering:** Send changed requirements through the lead. It updates affected assignments and review criteria while preserving completed work.
- **Pause and resume:** Say `pause team` to stop dispatch and request that workers and their native children hold or stop. A reported human Esc or unexplained interruption holds that assignment until you resume it. The lead reports what stopped and what remains active or unverified. This is a best-effort behavioral convention, not an enforced global stop or a guarantee that background processes exited. Resume requires your explicit instruction; after a restart, the lead rediscovers identities and inspects existing work before dispatch.
- **Finish:** The lead reviews the complete candidate diff and source, evaluates any approved adversarial findings, and verifies relevant behavior, including a real browser for UI work when available. It reports changed files, checks, findings, and limitations, leaving tabs available and agents idle for inspection. Commit, merge, and publication authority comes from your task.

For a standalone implementation or review without a team, use the [direct native CLI guide](docs/direct-sessions.md).

## Why this is the default

Herdr owns terminals and agent control; the native lead owns assignments, integration, review, and final verification. A single skill supplies the workflow and reads Herdr's release-matched command instructions instead of maintaining a second control layer.

An earlier Herdr countertrial passed seven tests plus browser and user checks. The revised team skill has not yet been tested live end to end. That earlier result does not establish this revision's behavior or a performance advantage.

<a id="experimental-teams-in-cmux"></a>

## Historical harness workflows

The existing cmux harness code, manual starter, and daemon workflow remain available for existing installations and historical experiments. They are separate from the current Herdr team skill. The [cmux guide](docs/cmux-team.md#start-a-team) documents manual startup and the original ownership, messaging, review, and recovery model. Existing `start --daemon` users can use the [legacy guide](docs/legacy-workflow.md).

The [September 6 cmux trial findings](docs/native-workflow-findings.md) record the earlier workflow's limitations: neither coordinated small-task run reached feature acceptance during a twenty-minute observation window. Those findings concern that harness, not the revised Herdr skill.

## Development

The retained harness has its own Node.js dependencies and checks. They are not needed to install or invoke the Herdr team skill.

```sh
npm --prefix agent-team ci
npm --prefix agent-team run lint
npm --prefix agent-team test
```

The website is static HTML, CSS, and JavaScript under `site/`. GitHub Actions deploys it to GitHub Pages when `main` changes. [Image provenance](docs/website-image.md).
