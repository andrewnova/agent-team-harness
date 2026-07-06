const { appendJsonl, exists, readJson, readJsonl, writeJson } = require("../../fsutil");
const harnessPaths = require("../../paths");
const { canonicalPath, redactSensitiveDiagnostics } = require("./utils");
const { compactDiscovered, compactList, compactStatus } = require("./status");

function compactEnsureRecord(record) {
  const compacted = { ...record };
  if (compacted.status) compacted.status = compactStatus(compacted.status);
  if (compacted.initial_status) compacted.initial_status = compactStatus(compacted.initial_status);
  if (compacted.before_list) compacted.before_list = compactList(compacted.before_list);
  if (compacted.discovered) compacted.discovered = compactDiscovered(compacted.discovered);
  if (compacted.recovered_endpoint) compacted.recovered_endpoint = compactDiscovered(compacted.recovered_endpoint);
  if (compacted.remembered_endpoint) compacted.remembered_endpoint = compactDiscovered(compacted.remembered_endpoint);
  return redactSensitiveDiagnostics(compacted);
}

function sessionNameMatches(record, name, target) {
  if (!name && !target) return false;
  return (
    record.name === name ||
    record.target === target ||
    record.name === target ||
    record.target === name
  );
}

function loadEnsureSession(cwd, selector = {}) {
  const { name, target, projectCwd } = selector;
  // Multi-slot: when a specific session name is requested, pick the most recent OK
  // record for that name+project from the durable history. A recovery launch uses a
  // different name and is appended later; reading a single-slot session.json would let
  // it hijack the primary session's identity, so we select by name from the history.
  if (name || target) {
    try {
      const historyPath = harnessPaths.channelSessionsPath(cwd);
      if (exists(historyPath)) {
        const matches = readJsonl(historyPath).filter((record) => {
          if (!record || !record.ok) return false;
          if (!sessionNameMatches(record, name, target)) return false;
          if (projectCwd && record.project_dir) {
            return canonicalPath(record.project_dir) === canonicalPath(projectCwd);
          }
          return true;
        });
        if (matches.length) return matches[matches.length - 1];
      }
    } catch {
      // fall through to the single-slot pointer below
    }
  }
  const file = harnessPaths.channelSessionPath(cwd);
  if (!exists(file)) return null;
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function persistEnsure(cwd, record) {
  const stamped = {
    ...compactEnsureRecord(record),
    updated_at: new Date().toISOString()
  };
  appendJsonl(harnessPaths.channelSessionsPath(cwd), stamped);
  if (stamped.ok) writeJson(harnessPaths.channelSessionPath(cwd), stamped);
  return {
    ...stamped,
    session_path: harnessPaths.channelSessionPath(cwd),
    history_path: harnessPaths.channelSessionsPath(cwd)
  };
}

module.exports = {
  compactEnsureRecord,
  loadEnsureSession,
  persistEnsure
};
