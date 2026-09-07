#!/usr/bin/env bash
set -euo pipefail

refresh=false
for argument in "$@"; do
  case "$argument" in
    --refresh) refresh=true ;;
    -h|--help)
      cat <<'HELP'
Usage: scripts/install-team-skill.sh [--refresh]

Link the shared team skill into native Claude Code and Codex. The source clone
must remain available. By default, any different existing skill stops the install
before changes. --refresh preserves conflicts as hidden .team.backup.N siblings;
existing backups are never overwritten. Links to the same source are unchanged.
No CLI wrapper, daemon, MCP server, or native configuration is installed.

Paths honor AGENT_TEAM_AGENTS_SKILLS, CODEX_HOME, and CLAUDE_CONFIG_DIR;
configured paths must be absolute and must not overlap the source checkout.

Start native Claude Code or Codex inside the intended project's Herdr pane.
Claude Code: /team <task>
Codex: $team <task>
HELP
      exit 0
      ;;
    *) echo "Unknown argument: $argument" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SKILL_SOURCE="$ROOT/plugins/agent-team-harness/skills/team"
SKILL_HUB="${AGENT_TEAM_AGENTS_SKILLS:-$HOME/.agents/skills}"
CODEX_SKILLS="${CODEX_HOME:-$HOME/.codex}/skills"
CLAUDE_SKILLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"

fail() { echo "$*" >&2; exit 1; }
exists() { [ -e "$1" ] || [ -L "$1" ]; }
within() { case "$1/" in "${2%/}/"*) return 0 ;; *) return 1 ;; esac; }

[ -f "$SKILL_SOURCE/SKILL.md" ] || fail "Missing skill source: $SKILL_SOURCE/SKILL.md"
SOURCE_DIRECTORY="$(cd "$SKILL_SOURCE" && pwd -P)"

# Resolve existing parent symlinks without creating missing directories. This
# also handles aliases containing '..' before comparing destination trees.
canonical_directory() {
  local directory="${1%/}" parent
  [ -n "$directory" ] || directory=/
  if [ -d "$directory" ]; then
    (cd "$directory" && pwd -P)
    return
  fi
  exists "$directory" && fail "Not a directory: $directory"
  parent="$(canonical_directory "$(dirname "$directory")")" || return 1
  case "${directory##*/}" in
    .) printf '%s\n' "$parent" ;;
    ..) dirname "$parent" ;;
    *) printf '%s/%s\n' "${parent%/}" "${directory##*/}" ;;
  esac
}

same_source() {
  [ -L "$1" ] && [ -d "$1" ] &&
    [ "$(cd "$1" && pwd -P)" = "$SOURCE_DIRECTORY" ]
}

links=()
# Preflight all destinations, including physical aliases and nested overrides,
# before creating even their parent directories.
for directory in "$SKILL_HUB" "$CODEX_SKILLS" "$CLAUDE_SKILLS"; do
  case "$directory" in
    /*) ;;
    *) echo "Skill install paths must be absolute: $directory" >&2; exit 2 ;;
  esac
  directory="$(canonical_directory "$directory")"
  destination="${directory%/}/team"
  [ "$destination" = "$SOURCE_DIRECTORY" ] && continue
  if within "$destination" "$ROOT" || within "$ROOT" "$destination" ||
     within "$destination" "$SOURCE_DIRECTORY" || within "$SOURCE_DIRECTORY" "$destination"; then
    fail "Unsafe skill path overlaps the source checkout: $destination"
  fi
  duplicate=false
  for other in ${links[@]+"${links[@]}"}; do
    if [ "$destination" = "$other" ]; then
      duplicate=true
    elif within "$destination" "$other" || within "$other" "$destination" ||
         { [ -d "$other" ] && within "$destination" "$(cd "$other" && pwd -P)"; } ||
         { [ -d "$destination" ] && within "$other" "$(cd "$destination" && pwd -P)"; }; then
      fail "Skill destinations must not contain each other: $destination and $other"
    fi
  done
  $duplicate && continue
  if exists "$destination" && ! same_source "$destination" && ! $refresh; then
    fail "Preserving existing skill: $destination. Use --refresh to back it up and install the link."
  fi
  links+=("$destination")
done

created_directories=()
installed_links=()
backup_paths=()
backup_destinations=()

# Only undo this invocation's writes. Never recursively delete a directory or
# replace a path that appeared after a failed write; leave its backup for recovery.
rollback() {
  local status="$?" i destination backup
  trap - EXIT HUP INT TERM
  [ "$status" -eq 0 ] && return
  set +e
  for ((i=${#installed_links[@]}-1; i>=0; i--)); do
    destination="${installed_links[i]}"
    if [ -L "$destination" ] && [ "$(readlink "$destination")" = "$SKILL_SOURCE" ]; then
      rm "$destination" || echo "Could not remove installed link: $destination" >&2
    fi
  done
  for ((i=${#backup_paths[@]}-1; i>=0; i--)); do
    destination="${backup_destinations[i]}"
    backup="${backup_paths[i]}"
    if ! exists "$destination"; then
      mv -n "$backup" "$destination"
    fi
    if exists "$backup"; then
      echo "Backup retained; restore manually: $backup -> $destination" >&2
    fi
  done
  for ((i=${#created_directories[@]}-1; i>=0; i--)); do
    rmdir "${created_directories[i]}" 2>/dev/null ||
      echo "Created directory retained: ${created_directories[i]}" >&2
  done
  exit "$status"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

make_directory() {
  local directory="$1"
  [ -d "$directory" ] && return
  exists "$directory" && fail "Not a directory: $directory"
  make_directory "$(dirname "$directory")"
  mkdir "$directory"
  created_directories+=("$directory")
}

for destination in ${links[@]+"${links[@]}"}; do
  same_source "$destination" && continue
  directory="$(dirname "$destination")"
  make_directory "$directory"
  # Detect a changed parent before moving anything through it.
  [ "$(canonical_directory "$directory")" = "$directory" ] || fail "Skill parent changed: $directory"
  if exists "$destination"; then
    $refresh || fail "Preserving existing skill: $destination. Retry with --refresh."
    number=1
    backup="$directory/.team.backup.$number"
    while exists "$backup"; do
      number=$((number + 1))
      backup="$directory/.team.backup.$number"
    done
    mv -n "$destination" "$backup"
    backup_paths+=("$backup")
    backup_destinations+=("$destination")
    exists "$destination" && fail "Could not preserve existing skill: $destination"
  fi
  ln -s "$SKILL_SOURCE" "$destination"
  installed_links+=("$destination")
done

for backup in ${backup_paths[@]+"${backup_paths[@]}"}; do
  echo "Preserved existing skill: $backup"
done
cat <<'SUCCESS'
Team skill installed. Start native Claude Code or Codex inside the intended
project's Herdr pane. Start a new native session if the skill is not visible yet.
Claude Code: /team <task>
Codex: $team <task>
SUCCESS
