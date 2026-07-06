const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { tempRoot, writeExecutable } = require("./helpers");
const { claudeAuthStatus } = require("../src/bridge/claudeChannel/auth");

function fakeClaude(dir, lines) {
  const file = path.join(dir, "claude");
  writeExecutable(file, lines);
  return { command: file, ok: true, path: file };
}

test("AUTH-1 logged-in status is verified", () => {
  const dir = tempRoot();
  const claude = fakeClaude(dir, ["#!/bin/sh", "echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}'", "exit 0"]);
  const status = claudeAuthStatus(claude, dir);
  assert.equal(status.status, "logged_in");
  assert.equal(status.ok, true);
});

test("AUTH-2 loggedIn:false is a DEFINITE logged_out (blocks)", () => {
  const dir = tempRoot();
  const claude = fakeClaude(dir, ["#!/bin/sh", "echo '{\"loggedIn\":false}'", "exit 0"]);
  const status = claudeAuthStatus(claude, dir);
  assert.equal(status.status, "logged_out");
  assert.equal(status.ok, false);
});

test("AUTH-3 non-JSON output is unverifiable, NOT logged_out", () => {
  const dir = tempRoot();
  const claude = fakeClaude(dir, ["#!/bin/sh", "echo 'permission denied'", "exit 0"]);
  const status = claudeAuthStatus(claude, dir);
  assert.equal(status.status, "unverifiable");
  assert.equal(status.ok, false);
});

test("AUTH-4 spawn failure (sandboxed/missing) is unverifiable, NOT logged_out", () => {
  const dir = tempRoot();
  const status = claudeAuthStatus({ command: path.join(dir, "no-such-claude") }, dir);
  assert.equal(status.status, "unverifiable");
  assert.equal(status.ok, false);
});
