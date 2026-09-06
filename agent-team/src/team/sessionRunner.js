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
async function runSession(file, { onResult = notifyResult } = {}) {
  const launch = JSON.parse(fs.readFileSync(file, "utf8"));
  const { root, job_id, attempt } = launch;
  const directory = path.dirname(file);
  jobs.claimRunner(root, job_id, attempt, process.pid);
  let child;
  let exited;
  let exit = { code: null, signal: null };
  let error;
  let stopAt;
  let stoppedForReport = false;
  let runnerError;
  let descendants;
  const stop = () => {
    if (!child?.pid) return;
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
      if (runnerError || current.status === "cancelling") stop();
      else if (current.reported_result && Date.now() - Date.parse(current.reported_result.reported_at) > 1000) {
        stoppedForReport = true;
        stop();
      }
    } catch (cause) { runnerError = cause; stop(); }
  }, 500);
  const onSignal = () => { try { jobs.cancelJob(root, job_id, attempt); } catch (cause) { runnerError = cause; } finally { stop(); } };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const workspace_id = process.env.CMUX_WORKSPACE_ID?.toLowerCase();
    const surface_id = process.env.CMUX_SURFACE_ID?.toLowerCase();
    if (!uuid.test(workspace_id || "") || !uuid.test(surface_id || "")) throw new Error("native runner must be launched inside its cmux workspace");
    jobs.bindJob(root, job_id, attempt, { workspace_id, surface_id, ...(launch.session_id ? { session_id: launch.session_id } : {}) });
    // Cancellation can win the race with the terminal's initial command.
    if (jobs.getJob(root, job_id).status !== "cancelling") {
      const env = { ...process.env };
      env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ""}`;
      delete env.CODEX_THREAD_ID;
      delete env.CLAUDECODE;
      child = spawn(launch.argv[0], launch.argv.slice(1), { cwd: launch.cwd, env, stdio: "inherit", detached: true });
      child.on("error", (cause) => { error = cause; });
      exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
      if (child.pid) {
        descendants = trackProcesses(child.pid);
        descendants.scan();
        jobs.bindJob(root, job_id, attempt, { workspace_id, surface_id, pid: child.pid });
      }
      exit = await exited;
    }
  } catch (cause) {
    runnerError = cause;
    stop();
    // Keep the escalation timer alive even when binding fails after spawn.
    if (exited) exit = await exited;
  } finally {
    clearInterval(timer);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
  let remaining = [];
  let process_stopped = !child?.pid;
  try {
    const deadline = Date.now() + 7000;
    while (child?.pid && (groupExists(child.pid) || descendants.scan().length) && Date.now() < deadline) {
      stop();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    remaining = descendants?.scan() || [];
    process_stopped = !child?.pid || (!groupExists(child.pid) && !remaining.length);
  } catch (cause) {
    runnerError = cause;
    stop();
  }
  const receipt = { job_id, attempt, runner_pid: process.pid, pid: child?.pid, ...exit, process_stopped, observed_processes: descendants?.identities() || [], remaining,
    error: error?.message || runnerError?.message, stopped_at: new Date().toISOString() };
  fs.writeFileSync(path.join(directory, "exit.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  if (!process_stopped) throw new Error("native descendants still alive; checkout claim retained");
  const current = jobs.getJob(root, job_id);
  const unexpectedExit = exit.code !== 0 && !stoppedForReport;
  const status = current.status === "cancelling" ? "cancelled" : error || runnerError || unexpectedExit ? "failed" : current.reported_result?.status || "failed";
  receipt.status = status;
  if (status === "failed" && unexpectedExit) receipt.error ||= `Native session exited unexpectedly (${exit.code ?? exit.signal ?? "no process"}); its result is not accepted.`;
  jobs.finishJob(root, job_id, attempt, { status, process_stopped, result: receipt.error || current.reported_result?.result ||
    (status === "cancelled" ? "Native job cancelled." : `Native session exited without a semantic result (${exit.code ?? exit.signal})`) });
  try { receipt.delivery = await onResult(root, job_id, attempt); }
  catch (cause) { receipt.delivery = { status: "failed", error: cause.message }; }
  fs.writeFileSync(path.join(directory, "exit.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  process.stdout.write(`\nAgent Team job ${job_id} ${status}; process stopped. Evidence: ${directory}\n`);
  return receipt;
}

function notifyResult(root, job_id, attempt) {
  const notice = jobs.jobFinishedMessage(root, job_id, attempt);
  if (!notice.message) return { status: "pending", reason: notice.reason };
  return { message_id: notice.message.id, ...require("./native").wakeMessage(root, notice.message) };
}

function retainTerminal() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.resume();
    process.stdout.write("This owned terminal is retained for inspection. Close this tab when finished.\n");
  }
}
if (require.main === module) runSession(process.argv[2]).then(retainTerminal).catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
  retainTerminal();
});
module.exports = { runSession, groupExists, notifyResult };
