const { loadTask, saveTask, recordEvent } = require("./state");
const { approvedReview } = require("./review");
const { loadProof, evaluateProof } = require("./proof");

const LEGAL = {
  goal: ["planning"],
  planning: ["ready"],
  ready: ["claimed"],
  claimed: ["implementing"],
  implementing: ["review"],
  review: ["merge"],
  merge: ["verifying"],
  verifying: ["done"],
  handoff: ["claimed", "human"],
  blocked: ["handoff", "human"],
  human: [],
  done: []
};

function gate(cwd, task, to) {
  const errors = [];
  if (!(LEGAL[task.status] || []).includes(to)) {
    errors.push(`illegal transition ${task.status} -> ${to}`);
    return errors;
  }
  if (to === "ready") {
    if (!task.objective) errors.push("objective is required");
    if (!task.acceptance_criteria.length) errors.push("acceptance criteria are required");
  }
  if (to === "review") {
    // Attempt presence is checked by command/test flows; allow manual import for Phase 0 fixtures.
  }
  if (to === "verifying" && !approvedReview(cwd, task)) {
    errors.push("approved review or review waiver is required");
  }
  if (to === "done") {
    const manifest = loadProof(cwd, task.task_id);
    if (!manifest) {
      errors.push("proof manifest is required");
    } else {
      errors.push(...evaluateProof(cwd, task, manifest).errors);
    }
  }
  return errors;
}

function transitionTask(cwd, taskId, to) {
  const task = loadTask(cwd, taskId);
  const errors = gate(cwd, task, to);
  if (errors.length > 0) return { ok: false, errors };
  const from = task.status;
  task.status = to;
  const saved = saveTask(cwd, task);
  recordEvent(cwd, {
    type: "task.transition",
    goal_id: saved.goal_id,
    task_id: saved.task_id,
    owner: saved.owner,
    reviewer: saved.reviewer,
    status: saved.status,
    detail: {
      from,
      to
    }
  });
  return { ok: true, task: saved };
}

module.exports = {
  LEGAL,
  gate,
  transitionTask
};
