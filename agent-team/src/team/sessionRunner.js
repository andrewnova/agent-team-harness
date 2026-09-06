#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const jobs = require("./jobs");
const { trackProcesses } = require("./processes");

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

// The wrapper runs inside the owned cmux terminal. Only this parent may turn
// native child exit + process-group disappearance into released job ownership.
async function runSession(file) {
  const launch = JSON.parse(fs.readFileSync(file, "utf8"));
  const { root, job_id, attempt } = launch;
  const directory = path.dirname(file);
  const original = jobs.getJob(root, job_id);
  if (original.attempt !== attempt || original.status !== "launching") throw new Error("native launch is stale or already started");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const workspace_id = process.env.CMUX_WORKSPACE_ID?.toLowerCase();
  const surface_id = process.env.CMUX_SURFACE_ID?.toLowerCase();
  if (!uuid.test(workspace_id || "") || !uuid.test(surface_id || "")) throw new Error("native runner must be launched inside its cmux workspace");
  jobs.bindJob(root, job_id, attempt, { workspace_id, surface_id, ...(launch.session_id ? { session_id: launch.session_id } : {}) });
  const env = { ...process.env };
  // Tab initial commands may receive only the system PATH. Codex's installed
  // JavaScript launcher uses /usr/bin/env node; use this validated Node runtime.
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ""}`;
  // Never let a child mistake the coordinating Codex session for its own.
  delete env.CODEX_THREAD_ID;
  delete env.CLAUDECODE;
  const child = spawn(launch.argv[0], launch.argv.slice(1), { cwd: launch.cwd, env, stdio: "inherit", detached: true });
  let error;
  child.on("error", (cause) => { error = cause; });
  if (child.pid) jobs.bindJob(root, job_id, attempt, { workspace_id, surface_id, pid: child.pid });
  let stopAt;
  let runnerError;
  const descendants = child.pid ? trackProcesses(child.pid) : null;
  try { descendants?.scan(); } catch (cause) { runnerError = cause; }
  const stop = () => {
    if (!child.pid) return;
    if (!stopAt) stopAt = Date.now();
    const signal = Date.now() - stopAt > 5000 ? "SIGKILL" : "SIGTERM";
    try { descendants?.stop(signal); } catch (cause) { runnerError = cause; }
    try { process.kill(-child.pid, signal); } catch (cause) {
      if (cause.code !== "ESRCH") runnerError = cause;
    }
  };
  const timer = setInterval(() => {
    try {
      descendants?.scan();
      const current = jobs.getJob(root, job_id);
      if (current.attempt !== attempt) throw new Error("native attempt changed while process is alive");
      if (current.status === "cancelling" || (current.reported_result && Date.now() - Date.parse(current.reported_result.reported_at) > 1000)) stop();
    } catch (cause) { runnerError = cause; stop(); }
  }, 500);
  const onSignal = () => { try { jobs.cancelJob(root, job_id, attempt); } finally { stop(); } };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const exit = await new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  clearInterval(timer);
  process.removeListener("SIGTERM", onSignal);
  process.removeListener("SIGINT", onSignal);
  // Clean up descendants after a natural parent exit, too.
  if (child.pid && (groupExists(child.pid) || descendants.scan().length)) stop();
  const deadline = Date.now() + 7000;
  while (child.pid && (groupExists(child.pid) || descendants.scan().length) && Date.now() < deadline) {
    stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const remaining = descendants?.scan() || [];
  const process_stopped = !child.pid || (!groupExists(child.pid) && !remaining.length);
  const receipt = { job_id, attempt, pid: child.pid, ...exit, process_stopped, observed_processes: descendants?.identities() || [], remaining,
    error: error?.message || runnerError?.message, stopped_at: new Date().toISOString() };
  fs.writeFileSync(path.join(directory, "exit.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  if (!process_stopped) throw new Error("native descendants still alive; checkout claim retained");
  const current = jobs.getJob(root, job_id);
  const status = current.status === "cancelling" ? "cancelled" : error || runnerError ? "failed" : current.reported_result?.status || "failed";
  jobs.finishJob(root, job_id, attempt, { status, process_stopped, result: receipt.error || current.reported_result?.result || `Native session exited without a semantic result (${exit.code ?? exit.signal})` });
  process.stdout.write(`\nAgent Team job ${job_id} ${status}; process stopped. Evidence: ${directory}\n`);
  return receipt;
}

function retainTerminal() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.resume();
    process.stdout.write("This owned terminal is retained for inspection. Close its workspace when finished.\n");
  }
}
if (require.main === module) runSession(process.argv[2]).then(retainTerminal).catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
  retainTerminal();
});
module.exports = { runSession, groupExists };
