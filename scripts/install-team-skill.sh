#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SOURCE_ROOT="$ROOT"
REFRESH=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --refresh) REFRESH=1; shift ;;
    --source)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--source requires an absolute clone path" >&2
        exit 2
      fi
      SOURCE_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/install-team-skill.sh [--refresh] [--source /absolute/clone/path]

Link team and agent-team-harness from one source into the shared skills hub,
Codex, and Claude Code. Requires Node.js (already required by agent-team).
The source defaults to this script's clone. Prefer a stable clone over a temporary
worktree: links use its real path, and it must remain available after installation.

By default, any different existing skill aborts the entire install unchanged.
--refresh moves conflicting files, directories, or symlinks to hidden numbered
siblings (.team.backup-1 or .agent-team-harness.backup-1, etc.) before linking.
Backups are never overwritten; relative symlink targets remain relative to the
same directory. Each backup path is printed. To restore, move the installed link
aside, then rename the backup to its original name. Repeated installs are no-ops.

No CLI wrapper, daemon, MCP server, or native configuration is installed.

Paths honor AGENT_TEAM_AGENTS_SKILLS, CODEX_HOME, and CLAUDE_CONFIG_DIR;
configured paths must be absolute.
EOF
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required; use the runtime installed for agent-team." >&2
  exit 1
fi

node - "$SOURCE_ROOT" "$REFRESH" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

function entryAt(target) {
  try { return fs.lstatSync(target); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function absolute(target) {
  if (!path.isAbsolute(target)) throw new Error(`Skill install paths must be absolute: ${target}`);
  return path.resolve(target);
}

// Resolve existing ancestors without creating directories. This both detects
// broken/non-directory parents and deduplicates native directories aliasing the hub.
function directoryPath(target) {
  if (entryAt(target)) {
    if (!fs.statSync(target).isDirectory()) throw new Error(`Not a directory: ${target}`);
    return fs.realpathSync(target);
  }
  return path.join(directoryPath(path.dirname(target)), path.basename(target));
}

function within(target, parent) {
  const relative = path.relative(parent, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolvesTo(target, source) {
  try { return fs.realpathSync(target) === source; }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return false;
    throw error;
  }
}

function writableParent(target) {
  let parent = path.dirname(target);
  while (!entryAt(parent)) parent = path.dirname(parent);
  fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
}

try {
  const sourceRoot = fs.realpathSync(absolute(process.argv[2]));
  const refresh = process.argv[3] === "1";
  const sources = ["team", "agent-team-harness"].map((name) => {
    const source = fs.realpathSync(path.join(sourceRoot, "plugins", "agent-team-harness", "skills", name));
    if (!fs.statSync(path.join(source, "SKILL.md")).isFile()) throw new Error(`Missing skill source: ${source}/SKILL.md`);
    return { name, source };
  });
  const directories = [...new Set([
    process.env.AGENT_TEAM_AGENTS_SKILLS || path.join(process.env.HOME, ".agents", "skills"),
    path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "skills"),
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, ".claude"), "skills")
  ].map((target) => directoryPath(absolute(target))))];
  const entries = directories.flatMap((directory) => sources.map(({ name, source }) => ({
    name, source, destination: path.join(directory, name)
  })));
  const plan = [];

  // Complete preflight before mkdir, backup, or link. Refuse layouts where an
  // install would move a source checkout or another install directory beneath it.
  for (const entry of entries) {
    const { name, source, destination } = entry;
    if (directories.some((directory) => within(directory, destination))) {
      throw new Error(`Overlapping skill install directories: ${destination}`);
    }
    const existing = entryAt(destination);
    if (destination === source || (existing?.isSymbolicLink() && resolvesTo(destination, source))) continue;
    if (within(destination, sourceRoot) || within(sourceRoot, destination) ||
        sources.some((item) => within(item.source, destination) || within(destination, item.source))) {
      throw new Error(`Install would modify a source checkout: ${destination}`);
    }
    if (existing && !refresh) {
      throw new Error(`Preserving existing skill: ${destination}. Use --refresh to back it up and replace it.`);
    }
    writableParent(destination);
    let backup = null;
    if (existing) {
      let number = 1;
      do { backup = path.join(path.dirname(destination), `.${name}.backup-${number++}`); }
      while (entryAt(backup));
    }
    plan.push({ ...entry, existing, backup });
  }

  const createdDirectories = [];
  const changes = [];
  function ensureDirectory(target) {
    if (entryAt(target)) return;
    ensureDirectory(path.dirname(target));
    fs.mkdirSync(target);
    createdDirectories.push(target);
  }

  try {
    for (const item of plan) {
      const { destination, source, existing, backup } = item;
      ensureDirectory(path.dirname(destination));
      const current = entryAt(destination);
      if (existing ? !current || current.dev !== existing.dev || current.ino !== existing.ino : current) {
        throw new Error(`Skill changed during installation: ${destination}`);
      }
      if (backup) {
        if (entryAt(backup)) throw new Error(`Backup appeared during installation: ${backup}`);
        fs.renameSync(destination, backup);
      }
      const change = { ...item, installed: false };
      changes.push(change);
      fs.symlinkSync(source, destination);
      change.installed = true;
    }
  } catch (error) {
    // Unexpected I/O failures restore previous entries as well. Never remove an
    // original skill or an entry changed by somebody else during this install.
    for (const change of changes.reverse()) {
      try {
        const current = entryAt(change.destination);
        if (change.installed) {
          if (!current?.isSymbolicLink() || fs.readlinkSync(change.destination) !== change.source) {
            throw new Error(`Installed entry changed: ${change.destination}`);
          }
          fs.unlinkSync(change.destination);
        }
        if (change.backup) {
          if (entryAt(change.destination)) throw new Error(`Destination occupied: ${change.destination}`);
          fs.renameSync(change.backup, change.destination);
        }
      } catch (restoreError) {
        console.error(`Restore manually from ${change.backup || change.destination}: ${restoreError.message}`);
      }
    }
    for (const directory of createdDirectories.reverse()) {
      try { fs.rmdirSync(directory); }
      catch (cleanupError) { console.error(`Preserving install directory ${directory}: ${cleanupError.message}`); }
    }
    throw error;
  }

  for (const { destination, backup } of plan) {
    if (backup) console.log(`Backup: ${destination} -> ${backup}`);
  }
  console.log(`Shared source clone: ${sourceRoot}`);
  console.log(`team and agent-team-harness installed (${plan.length} links changed).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
NODE

cat <<'EOF'
Start a new session if the skills are not visible yet.
Claude Code: /team <task>
Codex desktop: type @team, select the skill, then enter the task
Codex CLI: $team <task>
EOF
