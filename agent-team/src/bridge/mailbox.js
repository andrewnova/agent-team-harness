const manual = require("./manual");
const { appendMessage } = require("../mailbox");

function subjectFor(request) {
  const task = request.task_id || request.goal_id || "unknown";
  return `${request.kind || "request"} ${task}`;
}

function create() {
  const base = manual.create();
  return {
    name: "mailbox",
    request(cwd, request) {
      const row = base.request(cwd, { ...request, adapter: "mailbox" });
      const message = appendMessage(cwd, {
        id: row.request_id,
        from: request.from || "codex",
        to: request.to || "claude",
        kind: "request",
        subject: request.subject || subjectFor(request),
        body: request.prompt || "",
        task_id: request.task_id,
        goal_id: request.goal_id,
        run_id: request.run_id,
        request_id: row.request_id,
        request_kind: request.kind,
        target: request.target,
        reply_required: request.reply_required !== false,
        metadata: {
          prompt_path: row.prompt_path,
          timeout_ms: request.timeout_ms,
          owner: request.owner,
          reviewer: request.reviewer,
          nonblocking: true
        }
      }).message;
      return {
        ...row,
        mailbox_message_id: message.id,
        nonblocking: true,
        dispatch_state: "queued"
      };
    },
    importResponse: base.importResponse
  };
}

module.exports = { create };
