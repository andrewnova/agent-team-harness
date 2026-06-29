const fs = require("node:fs");
const path = require("node:path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeText(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, value.endsWith("\n") ? value : `${value}\n`);
}

function exists(file) {
  return fs.existsSync(file);
}

module.exports = {
  ensureDir,
  readJson,
  writeJson,
  appendJsonl,
  readJsonl,
  writeText,
  exists
};
