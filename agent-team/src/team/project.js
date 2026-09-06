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
  for (const field of ["workspace_id", "surface_id"]) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project[field] || "")) throw new Error(`invalid project ${field}`);
  }
  return project;
}

function save(file, project) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(project, null, 2), { flag: "wx", mode: 0o600 });
  fs.renameSync(temp, file);
  return project;
}

function ensureProject(root, { transport = createTransport(), title = path.basename(fs.realpathSync(root)) } = {}) {
  const existing = getProject(root);
  if (existing) return existing;
  const file = location(root);
  const lock = `${file}.lock`;
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === "EEXIST") throw new Error("cmux project creation is pending or uncertain; inspect before retrying");
    throw error;
  }
  try {
    const concurrent = getProject(root);
    if (concurrent) { fs.rmdirSync(lock); return concurrent; }
    const project = { ...transport.createProject({ cwd: fs.realpathSync(root), title }), title };
    save(file, project);
    fs.rmdirSync(lock);
    return project;
  } catch (error) {
    // A lost allocation response must not create duplicate sidebar projects.
    fs.writeFileSync(path.join(lock, "error.json"), JSON.stringify({ error: error.message, created_at: new Date().toISOString() }));
    throw error;
  }
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
