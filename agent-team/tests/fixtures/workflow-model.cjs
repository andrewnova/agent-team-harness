// Deterministic model stand-in. It consumes the real native launch flags and
// speaks JSON-lines MCP to the real per-session server. No job state is written.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

async function main() {
  const argv = process.argv.slice(2);
  const value = (flag) => argv[argv.indexOf(flag) + 1];
  let server;
  if (argv.includes("--mcp-config")) {
    server = JSON.parse(fs.readFileSync(value("--mcp-config"))).mcpServers.agent_team;
  } else {
    const config = (name) => JSON.parse(argv.find((item) => item.startsWith(`${name}=`)).slice(name.length + 1));
    server = { command: config("mcp_servers.agent_team.command"), args: config("mcp_servers.agent_team.args") };
  }
  const job = server.args[server.args.indexOf("--job") + 1];
  const attempt = server.args[server.args.indexOf("--attempt") + 1];
  const prefix = path.join(process.env.TEAM_WORKFLOW_FIXTURE, `${job}-${attempt}`);
  const threadId = `fixture-${job}-${attempt}`;
  // Deliberately omit CODEX_THREAD_ID: real Codex can omit it at MCP startup.
  const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let id = 0;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line); // Reject non-JSON-lines framing.
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });
  const request = (method, params) => new Promise((resolve) => {
    const key = ++id;
    pending.set(key, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n");
  });
  const initialized = await request("initialize", { protocolVersion: "2024-11-05" });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await request("tools/list", {});
  fs.writeFileSync(`${prefix}.boot.json`, JSON.stringify({ argv, initialized, listed, pid: process.pid, mcp_pid: child.pid }));
  let next = 1;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !fs.existsSync(`${prefix}.${next}.request.json`)) return;
    busy = true;
    const command = JSON.parse(fs.readFileSync(`${prefix}.${next}.request.json`));
    if (command.exit !== undefined) {
      // Abrupt native exit leaves the live MCP child for sessionRunner to reap.
      process.exit(command.exit);
    }
    const response = await request("tools/call", {
      name: command.name, arguments: command.args,
      _meta: { threadId: command.threadId || threadId }
    });
    fs.writeFileSync(`${prefix}.${next}.response.json`, JSON.stringify(response));
    next++;
    busy = false;
  }, 20);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    child.stdin.end();
    child.once("close", () => process.exit(0));
  });
  // A failed fixture never leaves a model alive indefinitely.
  setTimeout(() => process.exit(124), 45000).unref();
}

module.exports = { main };
