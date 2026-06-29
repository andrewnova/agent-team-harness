const manual = require("./manual");

function create(options = {}) {
  const base = manual.create();
  return {
    name: "mock",
    request(cwd, request) {
      const row = base.request(cwd, { ...request, adapter: "mock" });
      const task = request.task_snapshot;
      const response = {
        request_id: row.request_id,
        task_id: row.task_id,
        kind: row.kind,
        adapter: "mock",
        result_state: "answered",
        payload:
          options.payload ||
          (request.kind === "reground" && task
            ? {
                task_id: task.task_id,
                source: "claude",
                base_tree_hash: "mock-tree",
                restated_objective: task.objective,
                restated_acceptance: task.acceptance_criteria,
                active_tasks_state: [`${task.task_id} is ${task.status} and owned by ${task.owner}`],
                open_decisions: [],
                corrections: [],
                open_questions: []
              }
            : {
                verdict: "approve",
                summary: "Mock bridge response",
                findings: [],
                recommended_owner: request.recommended_owner || "codex"
              })
      };
      base.importResponse(cwd, response);
      return row;
    },
    importResponse: base.importResponse
  };
}

module.exports = { create };
