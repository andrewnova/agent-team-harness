const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const repository = path.resolve(__dirname, "../..");
const names = ["team", "agent-team-harness"];
const packagedSkills = path.join("plugins", "agent-team-harness", "skills");

// Redirect only the installer's fixed mutex directory, so even its lock files
// stay isolated from real installs. Optional barriers observe actual processes
// and SQLite transactions without adding production test switches.
const preload = `
const fs = require('node:fs');
const realpath = fs.realpathSync;
fs.realpathSync = (target, ...args) => realpath(target === '/tmp' ? process.env.INSTALL_TEST_MUTEX_ROOT : target, ...args);
if (process.env.INSTALL_TEST_EVENTS) {
  const actor = process.env.INSTALL_TEST_ACTOR;
  const event = (type, details = {}) => fs.appendFileSync(process.env.INSTALL_TEST_EVENTS, JSON.stringify({actor, type, ...details}) + '\\n');
  const {DatabaseSync} = require('node:sqlite');
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql === 'BEGIN IMMEDIATE') event('lock-attempt');
    const result = exec.call(this, sql);
    if (sql === 'BEGIN IMMEDIATE') event('acquired');
    return result;
  };
  const close = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function() { event('releasing'); return close.call(this); };
  let paused = false;
  let links = 0;
  for (const operation of ['mkdirSync', 'renameSync', 'symlinkSync', 'unlinkSync', 'rmdirSync']) {
    const original = fs[operation];
    fs[operation] = (...args) => {
      event('mutation', {operation});
      if (actor === 'first' && !paused && operation === 'renameSync' && args[1].endsWith('/.team.backup-1')) {
        paused = true;
        event('paused');
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(process.env.INSTALL_TEST_RELEASE)) {
          if (Date.now() > deadline) throw new Error('installer barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      if (operation === 'symlinkSync' && ++links === 2 && process.env.INSTALL_TEST_FAIL) throw new Error('injected link failure');
      return original(...args);
    };
  }
}
`;

function fixture(t) {
  // Never inherit real native skill targets, even when run from an installed app.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/team-skill-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mutexRoot = fs.realpathSync(fs.mkdtempSync("/tmp/team-skill-install-mutex-"));
  t.after(() => fs.rmSync(mutexRoot, { recursive: true, force: true }));
  const hook = path.join(mutexRoot, "preload.cjs");
  fs.writeFileSync(hook, preload);
  const source = path.join(root, "stable source clone");
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
  const script = path.join(source, "scripts", "install-team-skill.sh");
  fs.copyFileSync(path.join(repository, "scripts", "install-team-skill.sh"), script);
  for (const name of names) {
    fs.cpSync(path.join(repository, packagedSkills, name), path.join(source, packagedSkills, name), { recursive: true });
  }
  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
    NODE_OPTIONS: `--require ${hook}`,
    INSTALL_TEST_MUTEX_ROOT: mutexRoot,
    AGENT_TEAM_AGENTS_SKILLS: path.join(root, "shared skills"),
    CODEX_HOME: path.join(root, "codex config"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude config")
  };
  return {
    root, source, script, env,
    directories: [env.AGENT_TEAM_AGENTS_SKILLS, path.join(env.CODEX_HOME, "skills"), path.join(env.CLAUDE_CONFIG_DIR, "skills")],
    run(args = [], overrides = {}, installer = script) {
      return spawnSync("bash", [installer, ...args], {
        env: { ...env, ...overrides }, cwd: root, encoding: "utf8", timeout: 10000
      });
    }
  };
}

function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

function snapshot(root) {
  const entries = {};
  function visit(target) {
    const stat = fs.lstatSync(target);
    const key = path.relative(root, target);
    entries[key] = stat.isSymbolicLink() ? { link: fs.readlinkSync(target), inode: stat.ino }
      : stat.isDirectory() ? { directory: true, inode: stat.ino }
        : { bytes: fs.readFileSync(target).toString("base64"), inode: stat.ino };
    if (stat.isDirectory()) for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name));
  }
  visit(root);
  return entries;
}

function assertInstalled(f, source = f.source, directories = f.directories) {
  for (const directory of directories) {
    for (const name of names) {
      const installed = path.join(directory, name);
      assert.ok(fs.lstatSync(installed).isSymbolicLink());
      assert.equal(fs.realpathSync(installed), fs.realpathSync(path.join(source, packagedSkills, name)));
      assert.deepEqual(fs.readFileSync(path.join(installed, "SKILL.md")), fs.readFileSync(path.join(source, packagedSkills, name, "SKILL.md")));
    }
    // Resolve the actual sibling guide from the team's real source location.
    const guide = path.resolve(fs.realpathSync(path.join(directory, "team")), "../agent-team-harness/references/native-cmux.md");
    assert.deepEqual(fs.readFileSync(guide), fs.readFileSync(path.join(source, packagedSkills, "agent-team-harness", "references", "native-cmux.md")));
  }
}

function rejectsUnchanged(f, args = [], overrides = {}) {
  const before = snapshot(f.root);
  const result = f.run(args, overrides);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(snapshot(f.root), before);
}

test("installs both packaged skills into all apps from a spaced clone path and preserves other app files", (t) => {
  const f = fixture(t);
  for (const directory of f.directories) {
    fs.mkdirSync(path.join(directory, "unrelated-skill"), { recursive: true });
    fs.writeFileSync(path.join(directory, "unrelated-skill", "SKILL.md"), "leave this alone");
  }
  fs.writeFileSync(path.join(f.env.CODEX_HOME, "config.toml"), "existing Codex MCP config");
  fs.writeFileSync(path.join(f.env.CLAUDE_CONFIG_DIR, "settings.json"), "existing Claude config");
  const before = snapshot(f.root);
  success(f.run());
  assertInstalled(f);
  const after = snapshot(f.root);
  for (const [name, entry] of Object.entries(before)) assert.deepEqual(after[name], entry, name);
  const added = Object.keys(after).filter((name) => !(name in before));
  assert.deepEqual(added.sort(), f.directories.flatMap((directory) => names.map((name) => path.relative(f.root, path.join(directory, name)))).sort());
  success(f.run());
  success(f.run(["--refresh"]));
  assert.deepEqual(snapshot(f.root), after, "repeat install must preserve link inodes without new backups");
});

for (const layout of ["shared", "aliases", "partial overlap", "disjoint", "rollback"]) {
  test(`concurrent refreshes serialize preflight and mutation with ${layout} targets`, { timeout: 20000 }, async (t) => {
    const f = fixture(t);
    for (const directory of f.directories) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "team"), `original team at ${directory}`);
      fs.mkdirSync(path.join(directory, "agent-team-harness"));
      fs.writeFileSync(path.join(directory, "agent-team-harness", "SKILL.md"), "original local harness");
    }
    const originals = f.directories.flatMap((directory) => names.map((name) => ({
      backup: path.join(directory, `.${name}.backup-1`), contents: snapshot(path.join(directory, name))
    })));
    const secondSource = path.join(f.root, "second source clone");
    fs.cpSync(f.source, secondSource, { recursive: true });
    const sourcesBefore = [snapshot(f.source), snapshot(secondSource)];
    const overrides = {};
    if (layout === "aliases" || layout === "partial overlap") {
      const codexAlias = path.join(f.root, "codex alias");
      fs.symlinkSync(f.env.CODEX_HOME, codexAlias);
      overrides.CODEX_HOME = codexAlias;
    }
    if (layout === "aliases") {
      const hubAlias = path.join(f.root, "hub alias");
      fs.symlinkSync(f.directories[0], hubAlias);
      overrides.AGENT_TEAM_AGENTS_SKILLS = hubAlias;
    }
    if (layout === "partial overlap" || layout === "disjoint") {
      overrides.AGENT_TEAM_AGENTS_SKILLS = path.join(f.root, "other shared hub");
      overrides.CLAUDE_CONFIG_DIR = path.join(f.root, "other claude config");
      if (layout === "disjoint") overrides.CODEX_HOME = path.join(f.root, "other codex config");
    }
    const events = path.join(f.root, "events.jsonl");
    const release = path.join(f.root, "release");
    fs.writeFileSync(events, "");
    const trace = () => fs.readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const children = [];
    function launch(actor, source, extra = {}) {
      const child = spawn("bash", [f.script, "--refresh", "--source", source], {
        cwd: f.root, env: { ...f.env, INSTALL_TEST_EVENTS: events, INSTALL_TEST_ACTOR: actor, INSTALL_TEST_RELEASE: release, ...extra },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const result = new Promise((resolve) => {
        child.on("error", (error) => resolve({ error, stdout, stderr }));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      children.push(result);
      return result;
    }
    async function until(predicate) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (predicate(trace())) return;
        await delay(10);
      }
      assert.fail(`barrier did not arrive: ${JSON.stringify(trace())}`);
    }
    let first, second;
    try {
      first = launch("first", f.source, layout === "rollback" ? { INSTALL_TEST_FAIL: "1" } : {});
      await until((rows) => rows.some((row) => row.actor === "first" && row.type === "paused"));
      second = launch("second", secondSource, overrides);
      // On the unfixed installer this sees a second mutation instead of a lock
      // attempt while the first installer still owns its pre-rename barrier.
      await until((rows) => rows.some((row) => row.actor === "second" && ["lock-attempt", "mutation"].includes(row.type)));
      assert.equal(trace().some((row) => row.actor === "second" && row.type === "mutation"), false);
    } finally {
      fs.writeFileSync(release, "continue");
      await Promise.all(children);
    }
    const firstResult = await first;
    if (layout === "rollback") {
      assert.equal(firstResult.status, 1);
      assert.match(firstResult.stderr, /injected link failure/);
    } else success(firstResult);
    success(await second);
    let owner = null;
    for (const row of trace()) {
      if (row.type === "acquired") { assert.equal(owner, null, "installers must never overlap"); owner = row.actor; }
      if (row.type === "mutation") assert.equal(owner, row.actor, "every mutation, including rollback, must own the mutex");
      if (row.type === "releasing") { assert.equal(owner, row.actor); owner = null; }
    }
    assert.equal(owner, null);
    for (const original of originals) assert.deepEqual(snapshot(original.backup), original.contents, "preserve original bytes and inodes");
    assert.deepEqual([snapshot(f.source), snapshot(secondSource)], sourcesBefore, "both source clones remain unchanged");
    const secondEnv = { ...f.env, ...overrides };
    const secondDirectories = [secondEnv.AGENT_TEAM_AGENTS_SKILLS, path.join(secondEnv.CODEX_HOME, "skills"), path.join(secondEnv.CLAUDE_CONFIG_DIR, "skills")].map((directory) => fs.realpathSync(directory));
    assertInstalled(f, secondSource, secondDirectories);
    assertInstalled(f, f.source, f.directories.filter((directory) => !secondDirectories.includes(directory)));
  });
}

test("an explicit stable source survives removal of the installer worktree", (t) => {
  const f = fixture(t);
  const temporaryWorktree = path.join(f.root, "temporary worktree");
  fs.mkdirSync(temporaryWorktree);
  const installer = path.join(temporaryWorktree, "install-team-skill.sh");
  fs.copyFileSync(f.script, installer);
  const sourceAlias = path.join(f.root, "stable clone alias");
  fs.symlinkSync(f.source, sourceAlias);
  success(f.run(["--source", sourceAlias], {}, installer));
  fs.rmSync(temporaryWorktree, { recursive: true });
  fs.unlinkSync(sourceAlias);
  assertInstalled(f);
  for (const directory of f.directories) {
    for (const name of names) assert.equal(fs.readlinkSync(path.join(directory, name)), path.join(f.source, packagedSkills, name));
  }
});

test("late conflicts abort every destination, including default migration of old harness links", (t) => {
  const f = fixture(t);
  const last = f.directories.at(-1);
  fs.mkdirSync(last, { recursive: true });
  fs.symlinkSync("/tmp/missing-old-harness-source", path.join(last, "agent-team-harness"));
  rejectsUnchanged(f);
  assert.equal(fs.existsSync(f.directories[0]), false, "preflight must not even create the hub");
});

test("refresh preserves files, directories, absolute, relative, and dangling old links with recoverable backups", (t) => {
  const f = fixture(t);
  for (const directory of f.directories) fs.mkdirSync(directory, { recursive: true });
  const targets = f.directories.flatMap((directory) => names.map((name) => path.join(directory, name)));
  fs.writeFileSync(targets[0], "local team edits");
  fs.mkdirSync(targets[1]);
  fs.writeFileSync(path.join(targets[1], "SKILL.md"), "local harness edits");
  const oldSource = path.join(f.root, "old source");
  fs.mkdirSync(oldSource);
  fs.writeFileSync(path.join(oldSource, "SKILL.md"), "older skill");
  fs.symlinkSync(oldSource, targets[2]);
  fs.symlinkSync(path.relative(path.dirname(targets[3]), oldSource), targets[3]);
  fs.symlinkSync("missing-relative-source", targets[4]);
  fs.symlinkSync(path.join(f.root, "missing absolute source"), targets[5]);
  const originals = targets.map((target) => snapshot(target));
  // Existing backup slots include a dangling link, which must not be overwritten.
  fs.writeFileSync(path.join(f.directories[0], ".team.backup-1"), "earlier backup");
  fs.symlinkSync("missing-earlier-backup", path.join(f.directories[0], ".team.backup-2"));
  const result = f.run(["--refresh"]);
  success(result);
  assertInstalled(f);
  const backups = targets.map((target, index) => path.join(path.dirname(target), `.${path.basename(target)}.backup-${index === 0 ? 3 : 1}`));
  backups.forEach((backup, index) => {
    assert.deepEqual(snapshot(backup), originals[index]);
    assert.ok(result.stdout.includes(backup), "report every recoverable backup location");
  });
  assert.equal(fs.realpathSync(backups[3]), oldSource, "relative links retain their resolution in the backup");
  assert.equal(fs.readFileSync(path.join(f.directories[0], ".team.backup-1"), "utf8"), "earlier backup");
  assert.equal(fs.readlinkSync(path.join(f.directories[0], ".team.backup-2")), "missing-earlier-backup");
  assert.equal(fs.readFileSync(path.join(oldSource, "SKILL.md"), "utf8"), "older skill");
  const after = snapshot(f.root);
  success(f.run(["--refresh"]));
  assert.deepEqual(snapshot(f.root), after);
  backups.forEach((backup, index) => {
    fs.renameSync(targets[index], `${targets[index]}.installed`);
    fs.renameSync(backup, targets[index]);
    assert.deepEqual(snapshot(targets[index]), originals[index], "backup restores original bytes and link identity");
  });
});

test("aliased native and shared directories install once and refresh once", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.directories[0]);
  fs.mkdirSync(f.env.CODEX_HOME);
  fs.symlinkSync(f.directories[0], f.directories[1]);
  fs.symlinkSync(f.env.CODEX_HOME, f.env.CLAUDE_CONFIG_DIR);
  const hubAlias = path.join(f.root, "shared skills alias");
  fs.symlinkSync(f.directories[0], hubAlias);
  for (const name of names) fs.symlinkSync(`missing-old-${name}`, path.join(f.directories[0], name));
  const overrides = { AGENT_TEAM_AGENTS_SKILLS: hubAlias };
  rejectsUnchanged(f, [], overrides);
  success(f.run(["--refresh"], overrides));
  assertInstalled(f);
  assert.deepEqual(fs.readdirSync(f.directories[0]).sort(), [".agent-team-harness.backup-1", ".team.backup-1", ...names].sort());
  const after = snapshot(f.root);
  success(f.run(["--refresh"], overrides));
  assert.deepEqual(snapshot(f.root), after);
});

test("equivalent relative links and native links through the shared hub are left intact", (t) => {
  const f = fixture(t);
  for (const directory of f.directories) {
    fs.mkdirSync(directory, { recursive: true });
    for (const name of names) {
      const source = directory === f.directories[0] ? path.join(f.source, packagedSkills, name) : path.join(f.directories[0], name);
      fs.symlinkSync(path.relative(directory, source), path.join(directory, name));
    }
  }
  const before = snapshot(f.root);
  success(f.run());
  success(f.run(["--refresh"]));
  assertInstalled(f);
  assert.deepEqual(snapshot(f.root), before);
});

test("refresh aligns the old hub and native harness references while preserving all old pointers", (t) => {
  const f = fixture(t);
  for (const directory of f.directories) {
    fs.mkdirSync(directory, { recursive: true });
    fs.symlinkSync(directory === f.directories[0] ? path.join(f.root, "old clone", "agent-team-harness") : path.join(f.directories[0], "agent-team-harness"), path.join(directory, "agent-team-harness"));
  }
  const pointers = f.directories.map((directory) => fs.readlinkSync(path.join(directory, "agent-team-harness")));
  success(f.run(["--refresh"]));
  assertInstalled(f);
  f.directories.forEach((directory, index) => {
    assert.equal(fs.readlinkSync(path.join(directory, ".agent-team-harness.backup-1")), pointers[index]);
    assert.equal(fs.existsSync(path.join(directory, ".team.backup-1")), false);
  });
});

for (const kind of ["file", "dangling", "loop", "missing-child-of-file"]) {
  test(`a ${kind} native parent fails preflight even with refresh and earlier conflicts`, (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.directories[0]);
    fs.writeFileSync(path.join(f.directories[0], "team"), "keep this conflict untouched");
    if (kind === "file" || kind === "missing-child-of-file") fs.writeFileSync(f.env.CLAUDE_CONFIG_DIR, "not a directory");
    if (kind === "dangling") fs.symlinkSync("missing-native-config", f.env.CLAUDE_CONFIG_DIR);
    if (kind === "loop") fs.symlinkSync(f.env.CLAUDE_CONFIG_DIR, f.env.CLAUDE_CONFIG_DIR);
    rejectsUnchanged(f, ["--refresh"], kind === "missing-child-of-file" ? { CLAUDE_CONFIG_DIR: path.join(f.env.CLAUDE_CONFIG_DIR, "child") } : {});
  });
}

test("overlapping install directories cannot create or back up a skill containing another app's skills", (t) => {
  const f = fixture(t);
  rejectsUnchanged(f, ["--refresh"], { CODEX_HOME: path.join(f.directories[0], "team", "native config") });
});

test("refresh cannot move the source clone into a backup", (t) => {
  const f = fixture(t);
  const enclosingHub = path.join(f.root, "enclosing hub");
  const enclosedSource = path.join(enclosingHub, "team");
  fs.mkdirSync(enclosingHub);
  fs.renameSync(f.source, enclosedSource);
  f.source = enclosedSource;
  const before = snapshot(f.root);
  const result = f.run(["--refresh", "--source", enclosedSource], { AGENT_TEAM_AGENTS_SKILLS: enclosingHub }, path.join(enclosedSource, "scripts", "install-team-skill.sh"));
  assert.notEqual(result.status, 0);
  assert.deepEqual(snapshot(f.root), before);
});

test("installing into a packaged skill cannot add files to the source", (t) => {
  const f = fixture(t);
  rejectsUnchanged(f, ["--refresh"], { AGENT_TEAM_AGENTS_SKILLS: path.join(f.source, packagedSkills, "team") });
});

test("a shared directory that already is the packaged skill parent is preserved", (t) => {
  const f = fixture(t);
  const hub = path.join(f.source, packagedSkills);
  const before = snapshot(hub);
  success(f.run([], { AGENT_TEAM_AGENTS_SKILLS: hub }));
  assertInstalled(f, f.source, f.directories.slice(1));
  assert.deepEqual(snapshot(hub), before);
});

test("missing packaged siblings or SKILL.md prevent every destination change", (t) => {
  const f = fixture(t);
  const harness = path.join(f.source, packagedSkills, "agent-team-harness");
  fs.unlinkSync(path.join(harness, "SKILL.md"));
  rejectsUnchanged(f, ["--refresh"]);
  fs.rmSync(harness, { recursive: true });
  rejectsUnchanged(f, ["--refresh"]);
});

test("relative paths and invalid arguments cannot mutate install targets", (t) => {
  const f = fixture(t);
  for (const key of ["AGENT_TEAM_AGENTS_SKILLS", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    rejectsUnchanged(f, ["--refresh"], { [key]: "relative directory" });
  }
  for (const args of [["--source", "relative clone"], ["--source"], ["--source", ""], ["--refresh", "--unknown"]]) rejectsUnchanged(f, args);
  const before = snapshot(f.root);
  success(f.run(["--help"]));
  assert.deepEqual(snapshot(f.root), before);
});
