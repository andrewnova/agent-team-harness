#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
BIN_DIR="${AGENT_TEAM_BIN_DIR:-$HOME/.local/bin}"
TOOLS_DIR="${AGENT_TEAM_TOOLS_DIR:-$HOME/.local/share/agent-team}"
CHANNEL_VERSION="${AGENT_TEAM_CHANNEL_VERSION:-0.3.0}"
RUN_TESTS=1
INSTALL_CHANNEL=1
SETUP_CHANNEL_MCP=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-tests)
      RUN_TESTS=0
      shift
      ;;
    --skip-channel)
      INSTALL_CHANNEL=0
      shift
      ;;
    --no-channel-mcp)
      SETUP_CHANNEL_MCP=0
      shift
      ;;
    --channel-version)
      CHANNEL_VERSION="${2:?--channel-version requires a value}"
      shift 2
      ;;
    --tools-dir)
      TOOLS_DIR="${2:?--tools-dir requires a value}"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/install-codex.sh [--skip-tests] [--skip-channel] [--no-channel-mcp] [--channel-version <version>] [--tools-dir <path>]

Installs the Agent Team Harness for local Codex use:
  - validates Node.js >= 22.13.0
  - writes an agent-team wrapper to $AGENT_TEAM_BIN_DIR or ~/.local/bin
  - installs the Codex skill to $CODEX_HOME/skills/agent-team-harness
  - installs and registers the first-party agent-team-claude MCP server
  - installs the managed Claude channel bridge unless --skip-channel is passed
  - attempts legacy Claude channel MCP registration unless --no-channel-mcp is passed
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

mkdir -p "$CODEX_HOME/skills"
rm -rf "$CODEX_HOME/skills/agent-team-harness.tmp"
mkdir -p "$CODEX_HOME/skills/agent-team-harness.tmp"
cp -R "$ROOT/plugins/agent-team-harness/skills/agent-team-harness/." "$CODEX_HOME/skills/agent-team-harness.tmp/"
rm -rf "$CODEX_HOME/skills/agent-team-harness"
mv "$CODEX_HOME/skills/agent-team-harness.tmp" "$CODEX_HOME/skills/agent-team-harness"

node -e 'const fs=require("node:fs"); JSON.parse(fs.readFileSync(process.argv[1],"utf8"));' \
  "$ROOT/plugins/agent-team-harness/.codex-plugin/plugin.json"

if [ "$RUN_TESTS" -eq 1 ]; then
  (cd "$ROOT/agent-team" && npm test)
fi

if [ "$INSTALL_CHANNEL" -eq 1 ]; then
  channel_args=(channel install --version "$CHANNEL_VERSION" --tools-dir "$TOOLS_DIR" --bin-dir "$BIN_DIR")
  if [ "$SETUP_CHANNEL_MCP" -eq 0 ]; then
    channel_args+=(--no-setup-mcp)
  fi
  node "$ROOT/agent-team/src/cli.js" "${channel_args[@]}"
fi

echo
echo "Agent Team Harness installed."
echo "CLI wrapper: $BIN_DIR/agent-team"
echo "Codex skill: $CODEX_HOME/skills/agent-team-harness"
if [ "$INSTALL_CHANNEL" -eq 1 ]; then
  echo "Managed Claude channel bridge: $TOOLS_DIR/claude-channel-cli"
  echo "First-party Claude MCP wrapper: $BIN_DIR/agent-team-claude-mcp"
else
  echo
  echo "Managed Claude channel bridge was skipped."
  echo "Install it later with:"
  echo "  agent-team channel install"
  echo "  agent-team channel mcp install"
fi
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
