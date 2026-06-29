const crypto = require("node:crypto");
const { appendJsonl, writeText } = require("../fsutil");
const paths = require("../paths");

function create() {
  return {
    name: "manual",
    request(cwd, request) {
      const requestId = request.request_id || `req_${crypto.randomUUID()}`;
      const promptPath = request.prompt_path || `.agent-team/comms/claude-channel/${requestId}.md`;
      const adapter = request.adapter || "manual";
      const row = {
        ...request,
        request_id: requestId,
        adapter,
        prompt_path: promptPath,
        result_state: "pending",
        created_at: new Date().toISOString()
      };
      appendJsonl(paths.requestsPath(cwd), row);
      writeText(require("node:path").join(cwd, promptPath), request.prompt || "");
      return row;
    },
    importResponse(cwd, response) {
      const row = {
        adapter: "manual",
        result_state: response.result_state || "answered",
        collected_at: new Date().toISOString(),
        ...response
      };
      appendJsonl(paths.responsesPath(cwd), row);
      return row;
    }
  };
}

module.exports = { create };
