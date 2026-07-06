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

function readJsonlDetailed(file) {
  if (!fs.existsSync(file)) return { rows: [], malformed: [] };
  const rows = [];
  const malformed = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line) return;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      malformed.push({ line_number: index + 1, content: line, error: error.message });
    }
  });
  return { rows, malformed };
}

function readJsonl(file) {
  // Tolerate a corrupt/torn line (e.g. a partial concurrent append) rather than throwing:
  // a single bad line used to brick every reader in the hot path (state.init -> mirror
  // counts, cockpit, daemon). The bad line stays in the file, so nothing is lost; use
  // readJsonlDetailed / a repair pass to see and quarantine it.
  return readJsonlDetailed(file).rows;
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
  readJsonlDetailed,
  writeText,
  exists
};
