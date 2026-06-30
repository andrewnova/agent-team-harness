const { appendJsonl, exists, readJson, writeJson } = require("../../fsutil");
const harnessPaths = require("../../paths");
const { redactSensitiveDiagnostics } = require("./utils");
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

function loadEnsureSession(cwd) {
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
