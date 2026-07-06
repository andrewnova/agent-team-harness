#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
BIN_DIR="${AGENT_TEAM_BIN_DIR:-$HOME/.local/bin}"
RUN_TESTS=1
SETUP_CHANNEL_MCP=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-tests)
      RUN_TESTS=0
      shift
      ;;
    --skip-channel)
      SETUP_CHANNEL_MCP=0
      shift
      ;;
    --no-channel-mcp)
      SETUP_CHANNEL_MCP=0
      shift
      ;;
    --channel-version)
      echo "--channel-version is deprecated; the external Claude channel package is no longer installed." >&2
      shift 2
      ;;
    --tools-dir)
      echo "--tools-dir is deprecated; the external Claude channel package is no longer installed." >&2
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/install-codex.sh [--skip-tests] [--skip-channel] [--no-channel-mcp]

Installs the Agent Team Harness for local Codex use:
  - validates Node.js >= 22.13.0
  - writes an agent-team wrapper to $AGENT_TEAM_BIN_DIR or ~/.local/bin
  - links the Codex orchestrator + Claude teammate skills through the ~/.agents/skills hub
  - installs the first-party agent-team-codex MCP wrapper
  - installs and registers the first-party agent-team-claude MCP server
  - validates the bundled Codex plugin manifest
  - runs the Node test suite unless --skip-tests is passed
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js >= 22.13.0 and rerun this script." >&2
  exit 1
fi

node <<'NODE'
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && (minor < 13 || (minor === 13 && patch < 0)))) {
  console.error(`Node.js >= 22.13.0 is required; found ${process.versions.node}.`);
  process.exit(1);
}
NODE

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/agent-team" <<EOF
#!/usr/bin/env bash
exec node "$ROOT/agent-team/src/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/agent-team"

# Skills are shared through a per-user hub so both agents load the same files with zero
# copy-drift: the repo skill dirs are the one source of truth, ~/.agents/skills holds
# symlinks into the repo, and each agent's native skills dir links to the hub. Codex
# gets the orchestrator skill; Claude Code gets the teammate skill (each agent only
# ever loads its own role's skill).
AGENTS_SKILLS="${AGENT_TEAM_AGENTS_SKILLS:-$HOME/.agents/skills}"
CLAUDE_SKILLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
SKILLS_SRC="$ROOT/plugins/agent-team-harness/skills"
mkdir -p "$AGENTS_SKILLS" "$CODEX_HOME/skills" "$CLAUDE_SKILLS"

link_skill() {
  # $1 = link path, $2 = target. Back up (never delete) a pre-existing real directory,
  # which may hold uncommitted edits from the old copy-install.
  if [ -e "$1" ] && [ ! -L "$1" ]; then
    mv "$1" "$1.bak-$(date +%Y%m%d%H%M%S)"
  fi
  ln -sfn "$2" "$1"
}

# Hub entries point into the repo (one source of truth).
link_skill "$AGENTS_SKILLS/agent-team-harness"  "$SKILLS_SRC/agent-team-harness"
link_skill "$AGENTS_SKILLS/agent-team-teammate" "$SKILLS_SRC/agent-team-teammate"
# Role-scoped home links: Codex -> orchestrator skill, Claude Code -> teammate skill.
link_skill "$CODEX_HOME/skills/agent-team-harness" "$AGENTS_SKILLS/agent-team-harness"
link_skill "$CLAUDE_SKILLS/agent-team-teammate"    "$AGENTS_SKILLS/agent-team-teammate"

node -e 'const fs=require("node:fs"); JSON.parse(fs.readFileSync(process.argv[1],"utf8"));' \
  "$ROOT/plugins/agent-team-harness/.codex-plugin/plugin.json"

if [ "$RUN_TESTS" -eq 1 ]; then
  (cd "$ROOT/agent-team" && npm test)
fi

node "$ROOT/agent-team/src/cli.js" --cwd "$ROOT" codex mcp install --bin-dir "$BIN_DIR" --no-setup-adapter >/dev/null

channel_args=(channel install --bin-dir "$BIN_DIR")
if [ "$SETUP_CHANNEL_MCP" -eq 0 ]; then
  channel_args+=(--no-setup-mcp)
fi
node "$ROOT/agent-team/src/cli.js" "${channel_args[@]}"

echo
echo "Agent Team Harness installed."
echo "CLI wrapper: $BIN_DIR/agent-team"
echo "Skills hub: $AGENTS_SKILLS (repo-linked)"
echo "Codex skill: $CODEX_HOME/skills/agent-team-harness -> hub"
echo "Claude teammate skill: $CLAUDE_SKILLS/agent-team-teammate -> hub"
echo "First-party Codex MCP wrapper: $BIN_DIR/agent-team-codex-mcp"
echo "First-party Claude MCP wrapper: $BIN_DIR/agent-team-claude-mcp"
if ! printf '%s' ":$PATH:" | grep -Fq ":$BIN_DIR:"; then
  echo
  echo "Add this to your shell profile if agent-team is not found:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
fi
echo
echo "Start a new Codex thread, then ask Codex to use the agent-team-harness skill."
echo "From any project directory, run:"
echo "  agent-team start --name <project-name> --project-dir \"\$PWD\" --daemon"
echo "If Claude is not reachable yet, run:"
echo "  agent-team doctor --fix --target <project-name>"
