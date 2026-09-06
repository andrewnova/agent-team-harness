#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const readTools = new Set(["Read", "Glob", "Grep", "Agent", "SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskOutput", "TaskStop"]);
const teamTool = /^mcp__agent_team__(team_inbox|team_send|team_reply|team_report)$/;

// Native teammates can inherit the parent's MCP connection. Only the assigned
// harness session may use that job identity; children report to their parent.
function check(input, { session_id, writable }) {
  if (input.hook_event_name !== "PreToolUse") return {};
  const child = Boolean(input.agent_id) || input.session_id !== session_id;
  let reason;
  if (child && teamTool.test(input.tool_name)) reason = "The harness mailbox belongs to the parent job. Return your result with native agent messaging; only the parent may report or send as this job.";
  else if (!writable && !readTools.has(input.tool_name) && !(!child && teamTool.test(input.tool_name))) reason = "This review job and its native agents are read-only. Use the available reading and agent coordination tools.";
  return reason ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } : {};
}

function main(args) {
  try {
    const [directory, session_id, mode] = args;
    if (args.length !== 3 || !session_id || !["write", "read"].includes(mode)) throw new Error("invalid agent guard arguments");
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!input || Array.isArray(input) || !["PreToolUse", "SubagentStart", "SubagentStop"].includes(input.hook_event_name) || typeof input.session_id !== "string" || !input.session_id) throw new Error("invalid native hook payload");
    if (input.hook_event_name === "PreToolUse" && (typeof input.tool_name !== "string" || !input.tool_name)) throw new Error("native tool name is required");
    if (["SubagentStart", "SubagentStop"].includes(input.hook_event_name)) {
      fs.appendFileSync(path.join(directory, "native-agents.jsonl"), `${JSON.stringify({ event: input.hook_event_name, agent_id: input.agent_id, agent_type: input.agent_type, session_id: input.session_id, effort: input.effort, at: new Date().toISOString() })}\n`, { mode: 0o600 });
      if (input.hook_event_name === "SubagentStart") {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: `You are a native child of a harness job. Use the assigned model and effort. Return findings to your native parent; do not use the parent's agent_team MCP identity. ${mode === "read" ? "This entire assignment is read-only; do not change files or run commands." : "Use private worktrees for simultaneous writers, preserve other agents' edits, and stay within the assigned scope."}` } }));
      }
    } else process.stdout.write(JSON.stringify(check(input, { session_id, writable: mode === "write" })));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { check, main, readTools };
