#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SKILL_SOURCE="$ROOT/plugins/agent-team-harness/skills/team"
SKILL_HUB="${AGENT_TEAM_AGENTS_SKILLS:-$HOME/.agents/skills}"
CODEX_SKILLS="${CODEX_HOME:-$HOME/.codex}/skills"
CLAUDE_SKILLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"

if [ "$#" -gt 0 ]; then
  case "$1" in
    -h|--help)
      cat <<'EOF'
Usage: scripts/install-team-skill.sh

Link the shared team skill into Codex and Claude Code. The source clone must
remain available. Existing different files or links are preserved and reported.
No CLI wrapper, daemon, MCP server, or native configuration is installed.

Paths honor AGENT_TEAM_AGENTS_SKILLS, CODEX_HOME, and CLAUDE_CONFIG_DIR;
configured paths must be absolute.
EOF
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
fi

if [ ! -f "$SKILL_SOURCE/SKILL.md" ]; then
  echo "Missing skill source: $SKILL_SOURCE/SKILL.md" >&2
  exit 1
fi

for directory in "$SKILL_HUB" "$CODEX_SKILLS" "$CLAUDE_SKILLS"; do
  case "$directory" in
    /*) ;;
    *) echo "Skill install paths must be absolute: $directory" >&2; exit 2 ;;
  esac
done

links=("$SKILL_HUB/team" "$CODEX_SKILLS/team" "$CLAUDE_SKILLS/team")

# Preflight every destination before changing any links.
for destination in "${links[@]}"; do
  [ "$destination" = "$SKILL_SOURCE" ] && continue
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    if [ ! -L "$destination" ] || [ "$(readlink "$destination")" != "$SKILL_SOURCE" ]; then
      echo "Preserving existing skill: $destination. Choose another install location or move it explicitly." >&2
      exit 1
    fi
  fi
done

for destination in "${links[@]}"; do
  [ "$destination" = "$SKILL_SOURCE" ] && continue
  mkdir -p "$(dirname "$destination")"
  [ -L "$destination" ] || ln -s "$SKILL_SOURCE" "$destination"
done

cat <<'EOF'
Team skill installed. Start a new session if it is not visible yet.
Claude Code: /team <task>
Codex desktop: type @team, select the skill, then enter the task
Codex CLI: $team <task>
EOF
