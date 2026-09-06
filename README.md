# Agent Team Harness

<img src="site/assets/logo.svg" alt="Agent Team Harness logo" width="72">

**Run native Codex and Claude Code sessions together in cmux.**

One project in the sidebar. A lead and separate worker and reviewer tabs inside it. Give the lead a task, watch the agents work, and steer any session directly.

[Website](https://andrewnova.github.io/agent-team-harness/) · [Quickstart](#quickstart) · [Workflow and commands](docs/cmux-team.md)

![Conceptual illustration of four coding sessions connected through a shared mailbox inside one workspace](site/assets/cmux-team-hero.png)

*Illustration generated with GPT Image 2. Alpha software, maintained by Andrew Guzman.*

## Quickstart

You need **macOS**, [cmux](https://cmux.com/), Git, **Node.js 22.13 or later**, and the native [Codex](https://learn.chatgpt.com/docs/codex/cli) and [Claude Code](https://code.claude.com/docs/en/setup) CLIs installed and signed in. Your accounts must have access to the configured models.

Open a terminal **inside cmux**, then run:

```sh
git clone https://github.com/andrewnova/agent-team-harness.git
cd agent-team-harness
node scripts/start-team.js --project /absolute/path/to/your/repo
```

Replace the project path with an existing Git repository. The starter opens a **Team · your-project** workspace and launches an Astra lead. Complete any native trust or login prompts in its tab. Once it reports ready, give it a task:

> Add a settings page with saved notification preferences. Inspect the existing app first, split independent work, and verify the complete user flow.

The lead creates worker and reviewer tabs as needed. Up to **four jobs, including the lead**, can be active by default. The starter does not schedule tasks itself.

To use a Fable lead:

```sh
node scripts/start-team.js --project /absolute/path/to/your/repo --leader claude
```

The starter creates local coordinator state outside your source checkout. It supplies team communication tools per session; this path needs no global harness installation, global MCP registration, or receiver daemon. Running the same command again reports an existing active lead without creating a duplicate.

Use `--max-active` to set capacity, `--codex-bin` and `--claude-bin` to select explicit executable paths, or `--codex-model` and `--claude-model` to choose model IDs available to your accounts. See all options with `node scripts/start-team.js --help`. These choices are explicit; the harness does not silently fall back to another model.

## Who does what

| Assignment | Default runtime and model |
| --- | --- |
| Lead | Codex / Astra, or Claude Code / Fable |
| Backend implementation and repairs | Codex / Astra |
| Frontend implementation and repairs | Claude Code / Fable |
| Review with an Astra lead | Fresh Fable sessions |
| Review with a Fable lead | Fresh Astra sessions |

Default IDs are `gpt-6-astra` and `claude-fable-5-1[1m]`. Review is a separate assignment from implementation, even when the same model helped write part of the feature.

## From task to reviewed feature

1. **Define.** The lead inspects the project and writes a brief, assignments, and meaningful checks.
2. **Build.** Independent jobs run in parallel. Each simultaneous writer gets a private checkout.
3. **Assemble.** Worker commits are combined into one feature worktree.
4. **Freeze and review.** Fresh opposite-model reviewers inspect the complete candidate while checks run against that source.
5. **Repair and recheck.** The lead collects the review round, assigns justified repairs, then obtains current reviews and checks for the changed candidate.

A feature becomes eligible only when every required current review and check passes and required findings are resolved. Eligibility does not merge or deploy the feature.

## Three responsibilities

| Component | Responsibility |
| --- | --- |
| **cmux** | Visible project and tabs, direct steering, and addressed terminal wakes |
| **Native Codex / Claude Code** | Reasoning, editing, tool use, authentication, and approvals |
| **Harness** | Job ownership and capacity, durable messages, feature assembly, and evidence for acceptance |

Both CLIs receive the same local MCP tools: `team_report`, `team_send`, `team_inbox`, and `team_reply`. Messages stay in the local mailbox. A wake asks the recipient to read its inbox; only its actual response proves it answered.

The lead decides what to launch and what to accept. There is no additional scheduler or nested manager hierarchy.

## Inspect and stop

Startup prints the coordinator path and lead job ID. From the harness clone:

```sh
node agent-team/src/cli.js --cwd /absolute/coordinator team job list
node agent-team/src/cli.js --cwd /absolute/coordinator team job read <job-id>
node agent-team/src/cli.js --cwd /absolute/coordinator team job cancel <job-id>
```

Run terminal reads, launches, and wakes inside cmux. Cancellation requests termination; inspect the job until its recorded processes have stopped. Cancel or finish workers before stopping their lead. Tabs and local evidence remain available for inspection.

[Detailed job, assembly, review, and recovery commands](docs/cmux-team.md)

## Current boundaries

This is an alpha native workflow. Live grouped tabs, agent readiness, messages and replies in both directions, and shutdown have been exercised on macOS. CI runs lint and the test suite. Account access, native approvals, and model pauses can still block a job; incomplete work stays incomplete. Throughput improvement has not been benchmarked.

Code and prompts are processed by the selected native coding services. Local coordination does not mean offline model execution.

Existing users of the older `start --daemon` workflow can use the [legacy guide](docs/legacy-workflow.md). Its commands and bundled installer are separate from this cmux quickstart.

## Development

```sh
npm --prefix agent-team ci
npm --prefix agent-team run lint
npm --prefix agent-team test
```

The website is static HTML, CSS, and JavaScript under `site/`. GitHub Actions deploys it to GitHub Pages when `main` changes. [Image provenance](docs/website-image.md).
