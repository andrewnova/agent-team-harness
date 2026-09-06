#!/usr/bin/env node
const { runServer } = require("../mcp/teamServer");
const { wakeMessage } = require("./native");
const { getJob, bindJob } = require("./jobs");

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const values = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!["--cwd", "--job", "--attempt"].includes(args[i]) || !args[i + 1] || values[args[i]]) throw new Error("invalid MCP launch arguments");
      values[args[i]] = args[i + 1];
    }
    const root = values["--cwd"];
    const job_id = values["--job"];
    const attempt = Number(values["--attempt"]);
    const job = getJob(root, job_id);
    const nativeCaller = job.runtime === "codex" ? { runtime: "codex", thread_id: process.env.CODEX_THREAD_ID || null } : undefined;
    if (nativeCaller?.thread_id && !job.session_id) {
      bindJob(root, job_id, attempt, { workspace_id: job.workspace_id, surface_id: job.surface_id, session_id: nativeCaller.thread_id });
    }
    // Descendants inherit this required server. Keep their handshake healthy;
    // teamServer exposes no tools and rejects calls from a different thread.
    runServer({ root, job_id, attempt, nativeCaller, onMessage: (message) => wakeMessage(root, message) });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
