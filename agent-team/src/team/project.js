const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createTransport } = require("./cmux");

function location(root) {
  const canonical = fs.realpathSync(root);
  const directory = path.join(canonical, ".agent-team", "state");
  fs.mkdirSync(directory, { recursive: true });
  if (fs.realpathSync(directory) !== directory) throw new Error("project state must not be aliased");
  return path.join(directory, "cmux-project.json");
}

function getProject(root) {
  const file = location(root);
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error("project record must not be aliased");
  const project = JSON.parse(fs.readFileSync(file, "utf8"));
  return projectIdentity(project, project.title);
}

function save(file, project) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(project, null, 2), { flag: "wx", mode: 0o600 });
  fs.renameSync(temp, file);
  return project;
}

function ensureProject(root, { transport = createTransport(), title = path.basename(fs.realpathSync(root)) } = {}) {
  function live(project) {
    if (!project) return false;
    try { transport.readSession(project); return true; } catch (error) {
      if (error.code !== "CMUX_SURFACE_NOT_FOUND") throw error;
      return false;
    }
  }
  const current = getProject(root);
  if (live(current)) return current;
  const file = location(root);
  const lock = `${file}.lock`;
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === "EEXIST") return recoverProject(file, lock, transport);
    throw error;
  }
  let candidate;
  let existing;
  let uncertain = false;
  try {
    existing = getProject(root);
    if (live(existing)) return existing;
    title = existing?.title || title;
    const cwd = fs.realpathSync(root);
    candidate = existing
      ? transport.createSession({ workspace_id: existing.workspace_id,
        ...(existing.pane_id ? { pane_id: existing.pane_id } : {}),
        cwd, title: `${title} · controller`, command: { argv: ["/bin/sh"] } })
      : transport.createProject({ cwd, title });
    return save(file, projectIdentity(candidate, title, existing?.workspace_id));
  } catch (error) {
    // A known address can be adopted on retry. Unknown allocation outcomes stay
    // reserved; a read or validation error before allocation leaves no stale lock.
    if (candidate || error.launch_uncertain) {
      uncertain = true;
      fs.writeFileSync(path.join(lock, "error.json"), JSON.stringify({ error: error.message,
        session: candidate || error.session, workspace_id: existing?.workspace_id, title,
        created_at: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
    }
    throw error;
  } finally { if (!uncertain) fs.rmdirSync(lock); }
}

function projectIdentity(session, title, workspace_id) {
  const project = { workspace_id: session?.workspace_id, surface_id: session?.surface_id, title };
  if (session?.pane_id !== undefined) project.pane_id = session.pane_id;
  for (const field of ["workspace_id", "surface_id", ...(project.pane_id !== undefined ? ["pane_id"] : [])]) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project[field] || "")) throw new Error(`invalid project ${field}`);
    project[field] = project[field].toLowerCase();
  }
  if (workspace_id && project.workspace_id !== workspace_id.toLowerCase()) throw new Error("controller repair returned a different workspace");
  return project;
}

function recoverProject(file, lock, transport) {
  if (fs.lstatSync(lock).isSymbolicLink() || !fs.lstatSync(lock).isDirectory()) throw new Error("project allocation reservation must not be aliased");
  const evidence = path.join(lock, "error.json");
  const pending = () => new Error(`cmux project allocation is pending or uncertain; inspect ${evidence} before retrying`);
  if (!fs.existsSync(evidence)) throw pending();
  if (fs.lstatSync(evidence).isSymbolicLink()) throw new Error("project allocation evidence must not be aliased");
  // Recovery only validates and persists a returned UUID; it never reallocates.
  // Serialize adopters independently of the retained allocation reservation.
  const recovery = `${lock}.recovery`;
  try { fs.mkdirSync(recovery); } catch (error) {
    if (error.code === "EEXIST") throw pending();
    throw error;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(evidence, "utf8"));
    if (!saved.session?.workspace_id || !saved.session?.surface_id) throw pending();
    const project = projectIdentity(saved.session, saved.title, saved.workspace_id);
    transport.readSession(project);
    save(file, project);
    fs.unlinkSync(evidence);
    fs.rmdirSync(lock);
    return project;
  } finally { fs.rmdirSync(recovery); }
}

function attachProject(root, { workspace_id, surface_id, title }, transport = createTransport()) {
  const identity = transport.readSession({ workspace_id, surface_id });
  const file = location(root);
  const lock = `${file}.lock`;
  fs.mkdirSync(lock);
  try {
    const existing = getProject(root);
    if (existing && (existing.workspace_id !== identity.workspace_id || existing.surface_id !== identity.surface_id)) throw new Error("coordinator already belongs to another cmux project anchor");
    return save(file, { workspace_id: identity.workspace_id, surface_id: identity.surface_id, title: title || existing?.title || path.basename(fs.realpathSync(root)) });
  } finally { fs.rmdirSync(lock); }
}

module.exports = { getProject, ensureProject, attachProject };
