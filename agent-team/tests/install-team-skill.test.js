const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const installer = path.resolve(__dirname, "../../scripts/install-team-skill.sh");
const overrides = ["AGENT_TEAM_AGENTS_SKILLS", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];
const skillText = "---\nname: team\ndescription: Fixture skill\n---\n# Fixture team\n";

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function fixture(t, { defaults = false } = {}) {
  // Canonicalize macOS's /var -> /private/var alias; no real HOME or shell startup
  // environment is inherited. Even the default-path tests have an isolated HOME.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "team-installer-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  const clone = path.join(state, "fixture clone", "team");
  const script = path.join(clone, "scripts", "install-team-skill.sh");
  const source = path.join(clone, "plugins", "agent-team-harness", "skills", "team");
  write(path.join(source, "SKILL.md"), skillText);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(installer, script);
  const env = {
    HOME: path.join(state, "home"),
    TMPDIR: path.join(state, "tmp"),
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    AGENT_TEAM_AGENTS_SKILLS: path.join(state, "shared skills"),
    CODEX_HOME: path.join(state, "codex config"),
    CLAUDE_CONFIG_DIR: path.join(state, "claude config")
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  if (defaults) for (const key of overrides) delete env[key];
  return {
    root, state, clone, source, env,
    get destinations() {
      return [
        path.join(env.AGENT_TEAM_AGENTS_SKILLS || path.join(env.HOME, ".agents", "skills"), "team"),
        path.join(env.CODEX_HOME || path.join(env.HOME, ".codex"), "skills", "team"),
        path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME, ".claude"), "skills", "team")
      ];
    },
    run(args = []) {
      const result = spawnSync("/bin/bash", [script, ...args], {
        cwd: state, env, encoding: "utf8", timeout: 15000
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, `Installer terminated: ${result.signal}`);
      return result;
    }
  };
}

// lstat never follows links (including dangling ones). Identity checks catch a
// purported no-op that replaces an existing entry or rollback that loses it.
function snapshot(root) {
  const entries = {};
  function visit(file, relative) {
    const stat = fs.lstatSync(file);
    const entry = { mode: stat.mode, ino: stat.ino };
    if (stat.isSymbolicLink()) entry.link = fs.readlinkSync(file);
    else if (stat.isFile()) entry.contents = fs.readFileSync(file, "utf8");
    entries[relative] = entry;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    }
  }
  visit(root, ".");
  return entries;
}

function succeeded(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function failed(result) {
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function linked(f, destinations = f.destinations) {
  for (const destination of destinations) {
    assert.ok(fs.lstatSync(destination).isSymbolicLink(), destination);
    const target = fs.readlinkSync(destination);
    assert.ok(path.isAbsolute(target), target);
    assert.equal(target, f.source, destination);
    assert.equal(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"), skillText);
  }
}

function guidance(output) {
  assert.match(output, /native/i);
  assert.match(output, /Claude Code/);
  assert.match(output, /Herdr/);
  assert.match(output, /project/i);
  assert.match(output, /pane/i);
  assert.match(output, /Claude[^\n]*\/team <task>/);
  assert.match(output, /Codex[^\n]*\$team <task>/);
  assert.doesNotMatch(output, /Codex desktop|@team|autobootstrap|cmux/i);
}

function conflict(f, destination, kind) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (kind === "file") fs.writeFileSync(destination, "existing team file\n");
  else if (kind === "directory") write(path.join(destination, "nested", "keep.txt"), "existing team directory\n");
  else {
    const target = path.join(f.state, "previous skill");
    if (kind === "symlink") write(path.join(target, "SKILL.md"), "previous skill contents\n");
    fs.symlinkSync(target, destination);
  }
}

function backup(destination, number) {
  return path.join(path.dirname(destination), `.team.backup.${number}`);
}

function injectFailure(f, command, failingPath) {
  // Only this fixture's PATH is changed. The marker is outside installer state,
  // so rollback can be compared exactly without including shim bookkeeping.
  const controls = path.join(f.root, "controls");
  const shim = path.join(controls, command);
  const marker = path.join(controls, "failure-triggered");
  write(shim, `#!/bin/bash
for argument in "$@"; do
  if [ "$argument" = "$INSTALLER_TEST_FAIL_PATH" ]; then
    printf '%s\\n' "$argument" > "$INSTALLER_TEST_FAILURE_MARKER"
    echo "injected ${command} failure" >&2
    exit 1
  fi
done
exec /bin/${command} "$@"
`);
  fs.chmodSync(shim, 0o755);
  f.env.PATH = `${controls}:/usr/bin:/bin`;
  f.env.INSTALLER_TEST_FAIL_PATH = failingPath;
  f.env.INSTALLER_TEST_FAILURE_MARKER = marker;
  return () => assert.equal(fs.readFileSync(marker, "utf8"), `${failingPath}\n`);
}

test("team installer help describes native Herdr startup without changing files", (t) => {
  const f = fixture(t);
  const before = snapshot(f.state);
  for (const option of ["--help", "-h"]) {
    const result = f.run([option]);
    succeeded(result);
    assert.match(result.stdout, /--refresh/);
    guidance(result.stdout);
    assert.deepEqual(snapshot(f.state), before);
  }
});

test("team installer fresh defaults link all three locations to the absolute clone source", (t) => {
  const f = fixture(t, { defaults: true });
  const originalSource = snapshot(f.source);
  const result = f.run();
  succeeded(result);
  linked(f);
  assert.deepEqual(snapshot(f.source), originalSource);
  guidance(result.stdout);
});

test("team installer honors isolated overrides and preserves unrelated skills and native config", (t) => {
  const f = fixture(t);
  const protectedFiles = [
    path.join(f.env.HOME, ".claude.json"),
    path.join(f.env.CODEX_HOME, "config.toml"),
    path.join(f.env.CLAUDE_CONFIG_DIR, "settings.json"),
    ...f.destinations.map((destination) => path.join(path.dirname(destination), "other-skill", "SKILL.md"))
  ];
  for (const file of protectedFiles) write(file, `keep ${path.basename(file)}\n`);
  const before = protectedFiles.map(snapshot);
  succeeded(f.run());
  linked(f);
  assert.deepEqual(protectedFiles.map(snapshot), before);
  assert.deepEqual(fs.readdirSync(f.env.HOME), [".claude.json"]);
});

test("team installer repeats, including refresh, leave correct links untouched", (t) => {
  const f = fixture(t);
  succeeded(f.run());
  const before = snapshot(f.state);
  for (const args of [[], ["--refresh"]]) {
    succeeded(f.run(args));
    assert.deepEqual(snapshot(f.state), before);
  }
});

for (const kind of ["file", "directory", "symlink", "dangling symlink"]) {
  test(`team installer preflights a later ${kind} conflict before creating anything`, (t) => {
    const f = fixture(t);
    conflict(f, f.destinations[2], kind);
    const before = snapshot(f.state);
    failed(f.run());
    assert.deepEqual(snapshot(f.state), before);
  });

  test(`team installer refresh preserves a conflicting ${kind} as a hidden sibling`, (t) => {
    const f = fixture(t);
    const destination = f.destinations[0];
    conflict(f, destination, kind);
    const original = snapshot(destination);
    const sourceBefore = snapshot(f.source);
    const oldTarget = path.join(f.state, "previous skill");
    const targetBefore = fs.existsSync(oldTarget) ? snapshot(oldTarget) : null;
    succeeded(f.run(["--refresh"]));
    linked(f);
    assert.deepEqual(snapshot(backup(destination, 1)), original);
    assert.deepEqual(snapshot(f.source), sourceBefore);
    if (targetBefore) assert.deepEqual(snapshot(oldTarget), targetBefore);
    else assert.equal(fs.existsSync(oldTarget), false);
  });
}

test("team installer refresh skips existing backup slots, including dangling links", (t) => {
  const f = fixture(t);
  const destination = f.destinations[0];
  conflict(f, destination, "directory");
  write(backup(destination, 1), "older backup\n");
  fs.symlinkSync(path.join(f.state, "missing backup target"), backup(destination, 2));
  const originals = [destination, backup(destination, 1), backup(destination, 2)].map(snapshot);
  succeeded(f.run(["--refresh"]));
  linked(f);
  assert.deepEqual(snapshot(backup(destination, 3)), originals[0]);
  assert.deepEqual(snapshot(backup(destination, 1)), originals[1]);
  assert.deepEqual(snapshot(backup(destination, 2)), originals[2]);
  const after = snapshot(f.state);
  succeeded(f.run(["--refresh"]));
  assert.deepEqual(snapshot(f.state), after);
});

for (const refresh of [false, true]) {
  test(`team installer handles duplicate destinations through alias parents (${refresh ? "refresh" : "fresh"})`, (t) => {
    const f = fixture(t);
    const config = path.join(f.state, "shared config");
    const alias = path.join(f.state, "config alias");
    fs.mkdirSync(config);
    fs.symlinkSync(config, alias);
    f.env.AGENT_TEAM_AGENTS_SKILLS = path.join(config, "skills");
    f.env.CODEX_HOME = alias;
    f.env.CLAUDE_CONFIG_DIR = config;
    const destination = f.destinations[0];
    if (refresh) conflict(f, destination, "directory");
    const original = refresh ? snapshot(destination) : null;
    succeeded(f.run(refresh ? ["--refresh"] : []));
    linked(f);
    if (refresh) assert.deepEqual(snapshot(backup(destination, 1)), original);
    const before = snapshot(f.state);
    f.env.AGENT_TEAM_AGENTS_SKILLS = path.join(alias, "skills");
    f.env.CODEX_HOME = config;
    for (const args of [[], ["--refresh"]]) {
      succeeded(f.run(args));
      assert.deepEqual(snapshot(f.state), before);
    }
  });
}

test("team installer recognizes existing links through an alias of the source clone", (t) => {
  const f = fixture(t);
  const alias = path.join(f.state, "clone alias");
  fs.symlinkSync(f.clone, alias);
  const sourceAlias = path.join(alias, path.relative(f.clone, f.source));
  for (const destination of f.destinations) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(sourceAlias, destination);
  }
  const before = snapshot(f.state);
  for (const args of [[], ["--refresh"]]) {
    succeeded(f.run(args));
    assert.deepEqual(snapshot(f.state), before);
  }
});

for (const aliased of [false, true]) {
  test(`team installer leaves destination exactly equal to source untouched (${aliased ? "alias" : "direct"})`, (t) => {
    const f = fixture(t);
    const parent = path.dirname(f.source);
    const alias = path.join(f.state, "source parent alias");
    if (aliased) fs.symlinkSync(parent, alias);
    f.env.AGENT_TEAM_AGENTS_SKILLS = aliased ? alias : parent;
    const before = snapshot(f.source);
    succeeded(f.run(["--refresh"]));
    assert.deepEqual(snapshot(f.source), before);
    assert.ok(fs.lstatSync(f.source).isDirectory());
    linked(f, f.destinations.slice(1));
  });
}

for (const overlap of ["checkout ancestor", "inside checkout", "below source", "aliased checkout"]) {
  test(`team installer rejects ${overlap} overlap before refresh mutations`, (t) => {
    const f = fixture(t);
    if (overlap === "checkout ancestor") f.env.AGENT_TEAM_AGENTS_SKILLS = path.dirname(f.clone);
    else if (overlap === "inside checkout") f.env.AGENT_TEAM_AGENTS_SKILLS = path.join(f.clone, "new skills");
    else if (overlap === "below source") f.env.AGENT_TEAM_AGENTS_SKILLS = path.join(f.source, "nested skills");
    else {
      const alias = path.join(f.state, "checkout alias");
      fs.symlinkSync(f.clone, alias);
      f.env.AGENT_TEAM_AGENTS_SKILLS = path.join(alias, "new skills");
    }
    const before = snapshot(f.state);
    failed(f.run(["--refresh"]));
    assert.deepEqual(snapshot(f.state), before);
  });
}

for (const aliased of [false, true]) {
  test(`team installer rejects nested destinations before mutations (${aliased ? "alias" : "direct"})`, (t) => {
    const f = fixture(t);
    const ancestor = f.destinations[0];
    let parent = ancestor;
    if (aliased) {
      conflict(f, ancestor, "directory");
      parent = path.join(f.state, "destination alias");
      fs.symlinkSync(ancestor, parent);
    }
    f.env.CLAUDE_CONFIG_DIR = path.join(parent, "nested config");
    const before = snapshot(f.state);
    failed(f.run(["--refresh"]));
    assert.deepEqual(snapshot(f.state), before);
  });
}

for (const symlinkFirst of [false, true]) {
  test(`team installer rejects destinations nested through a skill symlink (${symlinkFirst ? "first" : "last"})`, (t) => {
    const f = fixture(t);
    const destination = f.destinations[symlinkFirst ? 0 : 2];
    conflict(f, destination, "symlink");
    if (symlinkFirst) f.env.CLAUDE_CONFIG_DIR = path.join(destination, "nested config");
    else f.env.AGENT_TEAM_AGENTS_SKILLS = path.join(destination, "nested skills");
    const before = snapshot(f.state);
    failed(f.run(["--refresh"]));
    assert.deepEqual(snapshot(f.state), before);
  });
}

for (const kind of ["file", "dangling symlink"]) {
  test(`team installer preflights a later non-directory parent (${kind})`, (t) => {
    const f = fixture(t);
    conflict(f, path.dirname(f.destinations[2]), kind);
    const before = snapshot(f.state);
    failed(f.run(["--refresh"]));
    assert.deepEqual(snapshot(f.state), before);
  });
}

for (const key of overrides) {
  test(`team installer rejects relative ${key} before mutations`, (t) => {
    const f = fixture(t);
    f.env[key] = "relative config";
    const before = snapshot(f.state);
    failed(f.run());
    assert.deepEqual(snapshot(f.state), before);
  });
}

for (const command of ["ln", "mkdir"]) {
  test(`team installer rolls back links and new empty parents after a later ${command} failure`, (t) => {
    const f = fixture(t);
    const destination = f.destinations[2];
    const wasTriggered = injectFailure(f, command, command === "ln" ? destination : path.dirname(destination));
    const before = snapshot(f.state);
    failed(f.run());
    wasTriggered();
    assert.deepEqual(snapshot(f.state), before);
  });
}

for (const command of ["ln", "mv"]) {
  test(`team installer rollback restores backups and correct links after a later ${command} failure`, (t) => {
    const f = fixture(t);
    const [existing, refreshed, failing] = f.destinations;
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.symlinkSync(f.source, existing);
    conflict(f, refreshed, "directory");
    conflict(f, failing, "dangling symlink");
    write(backup(refreshed, 1), "prior backup must survive rollback\n");
    write(path.join(path.dirname(failing), "other-skill", "SKILL.md"), "unrelated\n");
    const wasTriggered = injectFailure(f, command, failing);
    const before = snapshot(f.state);
    failed(f.run(["--refresh"]));
    wasTriggered();
    assert.deepEqual(snapshot(f.state), before);
  });
}
