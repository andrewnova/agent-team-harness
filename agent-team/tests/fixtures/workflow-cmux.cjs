// Test-only external cmux process boundary. No harness module is replaced.
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { randomUUID } = require("node:crypto");

if (process.env.TEAM_WORKFLOW_FIXTURE) {
  const directory = process.env.TEAM_WORKFLOW_FIXTURE;
  const stateFile = path.join(directory, "cmux.json");
  const originalSpawn = cp.spawn;
  function rpc(args) {
    if (args.slice(0, 4).join(" ") !== "--json --id-format uuids rpc") throw new Error("Unexpected cmux invocation");
    const method = args[4];
    const params = JSON.parse(args[5]);
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : null;
    const jobDirectory = path.join(process.env.TEAM_WORKFLOW_COORDINATOR, ".agent-team", "state", "jobs");
    const observedJobs = method === "surface.send_text"
      ? fs.readdirSync(jobDirectory).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(jobDirectory, name))))
      : undefined;
    fs.appendFileSync(path.join(directory, "rpc.jsonl"), JSON.stringify({ method, params, observedJobs }) + "\n");
    let result;
    if (method === "workspace.create") {
      if (state) throw new Error("Unexpected second workspace");
      result = { workspace_id: randomUUID(), pane_id: randomUUID(), surface_id: randomUUID() };
      fs.writeFileSync(stateFile, JSON.stringify({ ...result, surfaces: [{ id: result.surface_id, pane_id: result.pane_id, type: "terminal" }] }));
    } else {
      if (params.workspace_id !== state.workspace_id) throw new Error("Unknown fixture workspace");
      result = { workspace_id: state.workspace_id, surface_id: params.surface_id };
      if (method === "surface.create") {
        if (params.pane_id !== state.pane_id) throw new Error("Unknown fixture pane");
        const surface_id = randomUUID();
        state.surfaces.push({ id: surface_id, pane_id: state.pane_id, type: "terminal" });
        fs.writeFileSync(stateFile, JSON.stringify(state));
        const log = fs.openSync(path.join(directory, `${surface_id}.log`), "a");
        // Execute the actual cmux initial_command, including its POSIX quoting,
        // validated Node executable, sessionRunner and generated launch packet.
        const child = originalSpawn("/bin/sh", ["-c", params.initial_command], {
          cwd: params.working_directory, detached: true, stdio: ["ignore", log, log],
          env: { ...process.env, CMUX_WORKSPACE_ID: state.workspace_id, CMUX_SURFACE_ID: surface_id }
        });
        child.unref();
        fs.closeSync(log);
        fs.appendFileSync(path.join(directory, "runners.jsonl"), JSON.stringify({ pid: child.pid, surface_id }) + "\n");
        result = { ...result, surface_id, pane_id: state.pane_id, type: "terminal" };
      } else if (method === "surface.list") {
        result.surfaces = state.surfaces;
      } else if (method === "surface.read_text") {
        const log = path.join(directory, `${params.surface_id}.log`);
        result.text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "Fixture terminal";
      } else if (["surface.send_text", "surface.send_key", "tab.action"].includes(method)) {
        if (!state.surfaces.some((s) => s.id === params.surface_id)) throw new Error("Unknown fixture surface");
        if (method.startsWith("surface.send") && fs.existsSync(path.join(directory, "wake-unavailable"))) {
          return { status: 1, stderr: "fixture recipient transport unavailable", stdout: "" };
        }
      } else throw new Error(`Unexpected fixture RPC: ${method}`);
    }
    return { status: 0, stdout: JSON.stringify(result), stderr: "" };
  }
  for (const method of ["spawnSync", "spawn", "execFileSync", "execFile", "execSync", "exec"]) {
    const original = cp[method];
    cp[method] = (file, ...args) => {
      if (path.basename(file) === "cmux") {
        if (method !== "spawnSync") throw new Error("Unexpected async cmux execution");
        return rpc(args[0]);
      }
      if (![process.execPath, "git", "ps", "/bin/sh", path.join(directory, "native-model")].includes(file)) {
        throw new Error(`Unexpected external execution in workflow fixture: ${file}`);
      }
      return original(file, ...args);
    };
  }
}
