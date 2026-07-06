const path = require("node:path");
const { canonicalPath } = require("./utils");

function workspaceCwd(cwd, options = {}) {
  return canonicalPath(path.resolve(cwd, options.project_dir || "."));
}

function compactList(list) {
  if (!list) return null;
  return {
    ok: list.ok,
    transport: list.transport,
    sessions: Array.isArray(list.sessions) ? list.sessions : [],
    first_party_mcp: list.first_party_mcp
  };
}

function compactStatus(status) {
  if (!status) return null;
  return {
    ok: status.ok,
    delivery_ready: status.delivery_ready,
    visible_loaded: status.visible_loaded,
    transport: status.transport,
    target: status.target,
    session_name: status.session_name,
    launch_id: status.launch_id,
    first_party_mcp: status.first_party_mcp,
    launch_marker: status.launch_marker,
    mcp_start: status.mcp_start,
    mcp_init: status.mcp_init,
    boot_ack: status.boot_ack,
    operator_hint: status.operator_hint
  };
}

function compactDiscovered(discovered) {
  if (!discovered) return null;
  return {
    ok: discovered.ok,
    transport: discovered.transport,
    reason: discovered.reason,
    proof: discovered.proof || null
  };
}

module.exports = {
  workspaceCwd,
  compactList,
  compactStatus,
  compactDiscovered
};
