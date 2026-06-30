# Agent Team Harness

<img src="site/assets/logo.svg" alt="Agent Team Harness logo" width="96">

Alpha release: `0.1.0-alpha`

Created and maintained by Andrew Guzman.

Agent Team Harness is a local CLI for running Codex and Claude Code as coding teammates.

Codex owns the harness, task state, merge gates, and proof. Claude Code is the visible teammate for frontend/UI/UX work, long-context critique, and cross-model review. Communication is mailbox-first, so Codex can keep working while Claude is busy.

![Agent Team Harness flow](assets/agent-team-flow.svg)

Landing page: [`site/index.html`](site/index.html), deployable through GitHub Pages.

## What It Does

- Starts or reuses a visible Claude Code teammate for the current project.
- Stores goals, tasks, leases, reviews, proof, mailbox messages, and closeout records locally.
- Routes frontend work to Claude and backend/proof work to Codex.
- Uses a durable mailbox as the source of truth for teammate communication.
- Supports nonblocking review requests, semantic acknowledgements, check-ins, and batch replies.
- Requires proof before tasks can be marked done.
- Generates closeout reports and optional self-heal/refactor recommendations.

## Requirements

- Node.js `>=22.13.0`
- Codex
- Claude Code, for live Claude teammate sessions
- `npm`, used by the installer to fetch the pinned Claude channel bridge

## Install For Codex

```bash
git clone https://github.com/andrewnova/agent-team-harness.git
cd agent-team-harness
./scripts/install-codex.sh
```

The installer:

- validates Node.js,
- installs an `agent-team` wrapper into `~/.local/bin`,
- installs the Codex skill into `${CODEX_HOME:-~/.codex}/skills/agent-team-harness`,
- installs pinned `claude-channel-cli@0.3.0` into `~/.local/share/agent-team`,
- writes `claude-channel`, `claude-channel-server`, `agent-team-claude-mcp`, and `agent-team-codex-mcp` wrappers into `~/.local/bin`,
- registers the first-party `agent-team-claude` MCP server in Claude Code config,
- installs the first-party Codex MCP wake adapter wrapper for Codex-side mailbox reads,
- attempts legacy Claude channel MCP registration so the compatibility bridge works from any project,
- validates the bundled plugin manifest,
- runs the Node test suite.

If Claude Code is not installed or authenticated yet, the bridge install still completes and reports the next repair command. After Claude is ready, run:

```bash
agent-team doctor --fix --target my-project
agent-team channel auth
agent-team channel doctor --fix --target my-project
```

Offline or minimal install:

```bash
./scripts/install-codex.sh --skip-channel
agent-team channel install
agent-team channel mcp install
agent-team codex mcp install
```

## Quickstart

From any project directory:

```bash
agent-team start --name my-project --project-dir "$PWD" --daemon
```

When no `--name` is provided, the harness derives a session name from the project and the Codex thread id when `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, or `AGENT_TEAM_SESSION_ID` is available. That lets an old Codex thread reattach to its matching Claude teammate while a new Codex thread gets a separate visible Claude session by default. Passing `--name` remains the explicit override.

For offline or deterministic local testing:

```bash
agent-team start --name my-project --project-dir "$PWD" --no-ensure-claude
agent-team cockpit --no-live-channel
```

## Typical Flow

```bash
agent-team init
agent-team goal new --title "Build feature" --objective "Ship the feature with proof"
agent-team plan codex --goal G-000001 --text "Codex proposal"
agent-team plan claude --goal G-000001 --prompt "Review this plan"
agent-team plan import-claude --goal G-000001
agent-team plan reconcile --goal G-000001 --text "Final task split"
agent-team tasks create --json tasks.json
agent-team promote-dev
```

Then for each task:

```bash
agent-team claim T-000001 --owner codex --reason "backend/proof task"
agent-team attempt T-000001 --json attempt.json
agent-team review request T-000001
agent-team review import T-000001
agent-team merge T-000001
agent-team verify run T-000001
agent-team done T-000001
agent-team verify final
```

## Mailbox-First Communication

The mailbox is the durable communication truth. The managed Claude channel bridge is installed by the harness and is useful for startup, health checks, and explicit smoke tests, but normal development coordination should not depend on a synchronous reply window.

The receiver daemon is the bridge that makes Codex and Claude feel connected without blocking either model. It watches mailbox traffic, records receipt ACKs, surfaces semantic ACK/reply requirements, queues first-party Claude MCP channel notifications for Claude-bound non-heartbeat traffic, keeps the legacy Claude channel wake as a compatibility fallback when a live endpoint exists, queues Codex wake payloads for Claude-to-Codex messages, shows check-ins in cockpit, and lets Codex import Claude's answer when it arrives.

For Claude-to-Codex traffic, the daemon writes wake payloads under `.agent-team/comms/codex-wake/` and can invoke `AGENT_TEAM_CODEX_WAKE_COMMAND` with the payload path. The mailbox remains the source of truth; the wake stream is the local real-time delivery adapter for Codex surfaces that can consume it. The first-party `agent-team-codex-mcp` adapter reads that wake stream, loads mailbox messages, writes Codex ACKs, and sends Codex replies back through the same durable mailbox.

`agent-team cockpit` and `agent-team watch` show Claude MCP outbox totals, MCP-emitted counts, legacy fallback counts, Codex MCP adapter status, Codex wake totals, missing-adapter queues, the wake stream path, and a per-message timeline so operators can see whether teammate messages are moving in real time.

The cockpit timeline is derived from existing mailbox rows, ACK rows, MCP outbox/delivery rows, Codex wake payloads, Codex MCP receipts, and daemon events. It summarizes stages such as `mailbox_sent`, `claude_mcp_queued`, `claude_mcp_emitted`, `codex_wake_queued`, `codex_mcp_seen`, `mailbox_ack`, and `mailbox_reply` without creating a second state store.

Do not delegate real Claude work through raw `ask_claude` or a direct live-channel wait. Planning, implementation, review, refactor, and debugging work should go through mailbox-backed harness commands such as `plan claude`, `review request`, `channel steer`, or `mailbox send --to claude --kind request --reply-required`. The raw live channel is for health checks, smoke tests, low-level diagnostics, and the daemon's short wake-up copy; the mailbox reply remains the completion truth.

Claude can check in at any time:

```bash
agent-team mailbox send \
  --from claude \
  --to codex \
  --kind checkin \
  --task T-000001 \
  --subject "Still working" \
  --body "Waiting on frontend subagents; next milestone is mobile proof."
```

Codex can ask Claude for a nonblocking review:

```bash
agent-team review request T-000001
agent-team await reply --request-id req_... --once
agent-team review import T-000001 --request-id req_...
```

## First-Party Claude MCP Channel

The repo includes an experimental first-party Claude MCP server at `agent-team-claude-mcp`. It declares the Agent Team Claude Channel, watches `.agent-team/comms/claude-mcp/outbox.jsonl`, emits queued `notifications/claude/channel` wake-ups, exposes mailbox-backed tools for ACKs, replies, check-ins, status, and task opening, and writes Claude responses through the same durable mailbox as the CLI.

Install or inspect the first-party Claude MCP registration directly:

```bash
agent-team channel mcp install --mcp-scope user
agent-team channel mcp status --mcp-scope user
```

This is the migration target for replacing the managed `claude-channel-cli` bridge on the normal path. The daemon now writes the first-party outbox first and uses the legacy bridge as compatibility fallback. Until real visible-Claude dogfood is complete, the legacy bridge remains the supported startup/smoke compatibility path.

The MCP server uses standard stdio newline-delimited JSON-RPC. It waits until Claude sends the MCP `notifications/initialized` lifecycle event before emitting queued Claude Channel notifications, so queued outbox items cannot corrupt the startup handshake.

For clean teammate launches, `--fresh-claude` requires a genuinely new same-project channel endpoint. If no new endpoint appears, the harness reports `fresh_start_no_new_endpoint` instead of silently reusing or renaming an old Claude session.

For same Codex thread resumes, Claude channel ensure now prefers the remembered endpoint id from `.agent-team/comms/claude-channel/session.json` when `session_identity.thread_ref` and `project_dir` match. Display names are human labels and fallback selectors, not the primary continuity proof. Fresh launch failures include an endpoint probe (`discovered.probe` / `fresh_launch_probe`) with old endpoints, new endpoint counts, checked candidates, and the selected target when one exists. `agent-team cockpit` and `agent-team watch` render this as a `Claude startup:` line so visible-launch blockers are readable without opening JSON.

## First-Party Codex MCP Adapter

The repo also includes a first-party Codex-facing MCP server at `agent-team-codex-mcp`. It exposes mailbox-backed tools for Codex to watch Claude-to-Codex wake payloads, read full mailbox messages, acknowledge messages, reply to Claude, and open canonical task state. It does not replace the mailbox, and it does not claim to force a native Codex UI wake by itself; it is the clean local adapter that Codex surfaces or hooks can consume.

Install or inspect the Codex MCP adapter for a project:

```bash
agent-team codex mcp install
agent-team codex mcp status
```

The install command writes a wrapper into `~/.local/bin` and stores a local adapter manifest at `.agent-team/comms/codex-mcp/adapter.json`. `agent-team cockpit` reports whether that wrapper and manifest are present, how many wake payloads are pending, and where the stream lives.

## Project Layout

```text
agent-team/                         CLI source and tests
plugins/agent-team-harness/         Codex plugin/skill wrapper
scripts/install-codex.sh            local Codex installer
assets/agent-team-flow.svg          README diagram
```

Generated runtime state is written to `.agent-team/` in the project being operated on. It should not be committed.

Managed bridge tools are installed outside the repo at `~/.local/share/agent-team/claude-channel-cli` by default. Set `AGENT_TEAM_TOOLS_DIR` or pass `--tools-dir` to change that location.

## Development

```bash
cd agent-team
npm test
```

The suite covers task lifecycle, review import, mailbox behavior, durable waiting, daemon receipts, browser/computer proof gates, worktrees, closeout reports, and plugin launch behavior.

## Safety Notes

- Do not commit credentials, browser profiles, Claude channel tokens, provider keys, or generated `.agent-team/` runtime state.
- Use the CLI for state changes; do not hand-edit task JSON or SQLite.
- Codex remains final proof owner even when Claude implements or reviews work.
