const OWNERS = new Set(["codex", "claude", "human"]);
const STATUSES = new Set([
  "goal",
  "planning",
  "ready",
  "claimed",
  "implementing",
  "review",
  "merge",
  "verifying",
  "done",
  "handoff",
  "human",
  "blocked"
]);
const REVIEW_VERDICTS = new Set(["approve", "changes_requested", "block_merge", "waived"]);
const PROOF_VERDICTS = new Set(["pass", "fail"]);
const FRONTEND_FACETS = new Set(["frontend_ui", "ux_polish", "copy", "visual_qa"]);
const RUN_STATUSES = new Set(["active", "complete", "failed", "cancelled"]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

function validateGoal(goal) {
  assertObject(goal, "goal");
  assertString(goal.goal_id, "goal.goal_id");
  assertString(goal.title, "goal.title");
  assertString(goal.objective, "goal.objective");
  assertString(goal.status, "goal.status");
  return true;
}

function validateFrontendContract(task) {
  if (!FRONTEND_FACETS.has(task.facet) || task.owner !== "claude") return true;
  const contract = task.frontend_contract;
  assertObject(contract, "task.frontend_contract");
  assertString(contract.target_flow, "task.frontend_contract.target_flow");
  assertArray(contract.responsive_states, "task.frontend_contract.responsive_states");
  assertArray(contract.interaction_states, "task.frontend_contract.interaction_states");
  assertArray(contract.visual_acceptance, "task.frontend_contract.visual_acceptance");
  assertArray(contract.accessibility_expectations, "task.frontend_contract.accessibility_expectations");
  if (typeof contract.console_check_required !== "boolean") {
    throw new Error("task.frontend_contract.console_check_required must be boolean");
  }
  return true;
}

function validateToolPermissions(task) {
  if (task.tool_permissions === undefined) return true;
  assertObject(task.tool_permissions, "task.tool_permissions");
  if (
    task.tool_permissions.claude_chrome_extension !== undefined &&
    typeof task.tool_permissions.claude_chrome_extension !== "boolean"
  ) {
    throw new Error("task.tool_permissions.claude_chrome_extension must be boolean");
  }
  if (
    task.tool_permissions.codex_browser_proof !== undefined &&
    typeof task.tool_permissions.codex_browser_proof !== "boolean"
  ) {
    throw new Error("task.tool_permissions.codex_browser_proof must be boolean");
  }
  if (
    task.tool_permissions.codex_computer_use !== undefined &&
    typeof task.tool_permissions.codex_computer_use !== "boolean"
  ) {
    throw new Error("task.tool_permissions.codex_computer_use must be boolean");
  }
  return true;
}

function validateAccelerationPolicy(task) {
  if (task.acceleration_policy === undefined) return true;
  const policy = task.acceleration_policy;
  assertObject(policy, "task.acceleration_policy");
  for (const key of [
    "execution_profile",
    "codex_subagents",
    "claude_agent_teams",
    "token_budget",
    "write_isolation"
  ]) {
    if (policy[key] !== undefined && typeof policy[key] !== "string") {
      throw new Error(`task.acceleration_policy.${key} must be string`);
    }
  }
  if (policy.codex_final_authority !== undefined && typeof policy.codex_final_authority !== "boolean") {
    throw new Error("task.acceleration_policy.codex_final_authority must be boolean");
  }
  if (policy.max_codex_subagents !== undefined && (!Number.isInteger(policy.max_codex_subagents) || policy.max_codex_subagents < 1)) {
    throw new Error("task.acceleration_policy.max_codex_subagents must be a positive integer");
  }
  if (
    policy.max_claude_agent_team_subagents !== undefined &&
    typeof policy.max_claude_agent_team_subagents !== "string" &&
    (!Number.isInteger(policy.max_claude_agent_team_subagents) || policy.max_claude_agent_team_subagents < 1)
  ) {
    throw new Error("task.acceleration_policy.max_claude_agent_team_subagents must be a positive integer or string");
  }
  return true;
}

function validateTask(task) {
  assertObject(task, "task");
  assertString(task.task_id, "task.task_id");
  assertString(task.goal_id, "task.goal_id");
  assertString(task.title, "task.title");
  assertString(task.status, "task.status");
  if (!STATUSES.has(task.status)) throw new Error(`invalid task.status: ${task.status}`);
  assertString(task.owner, "task.owner");
  if (!OWNERS.has(task.owner)) throw new Error(`invalid task.owner: ${task.owner}`);
  assertString(task.reviewer, "task.reviewer");
  if (!OWNERS.has(task.reviewer)) throw new Error(`invalid task.reviewer: ${task.reviewer}`);
  assertString(task.facet, "task.facet");
  assertString(task.objective, "task.objective");
  if (task.goal_prompt !== undefined) assertString(task.goal_prompt, "task.goal_prompt");
  assertArray(task.acceptance_criteria, "task.acceptance_criteria");
  assertArray(task.allowed_paths, "task.allowed_paths");
  assertArray(task.forbidden_paths, "task.forbidden_paths");
  if (task.owner_history !== undefined) assertArray(task.owner_history, "task.owner_history");
  validateToolPermissions(task);
  assertObject(task.proof, "task.proof");
  assertArray(task.proof.commands, "task.proof.commands");
  if (typeof task.proof.requires_browser !== "boolean") {
    throw new Error("task.proof.requires_browser must be boolean");
  }
  if (typeof task.proof.requires_screenshot !== "boolean") {
    throw new Error("task.proof.requires_screenshot must be boolean");
  }
  if (task.proof.requires_computer !== undefined && typeof task.proof.requires_computer !== "boolean") {
    throw new Error("task.proof.requires_computer must be boolean");
  }
  assertObject(task.escalation_policy, "task.escalation_policy");
  validateAccelerationPolicy(task);
  validateFrontendContract(task);
  return true;
}

function validateAttempt(attempt) {
  assertObject(attempt, "attempt");
  assertString(attempt.task_id, "attempt.task_id");
  if (!Number.isInteger(attempt.attempt) || attempt.attempt < 1) {
    throw new Error("attempt.attempt must be a positive integer");
  }
  assertString(attempt.owner, "attempt.owner");
  assertString(attempt.hypothesis, "attempt.hypothesis");
  assertArray(attempt.changed_files, "attempt.changed_files");
  assertArray(attempt.commands, "attempt.commands");
  assertString(attempt.result, "attempt.result");
  return true;
}

function validateRun(run) {
  assertObject(run, "run");
  assertString(run.run_id, "run.run_id");
  assertString(run.kind, "run.kind");
  assertString(run.title, "run.title");
  assertString(run.status, "run.status");
  if (!RUN_STATUSES.has(run.status)) throw new Error(`invalid run.status: ${run.status}`);
  if (run.owner !== undefined) {
    assertString(run.owner, "run.owner");
    if (!OWNERS.has(run.owner)) throw new Error(`invalid run.owner: ${run.owner}`);
  }
  if (run.goal_id !== undefined && run.goal_id !== null) assertString(run.goal_id, "run.goal_id");
  if (run.task_id !== undefined && run.task_id !== null) assertString(run.task_id, "run.task_id");
  if (run.summary !== undefined && typeof run.summary !== "string") {
    throw new Error("run.summary must be string");
  }
  if (run.evidence !== undefined) assertArray(run.evidence, "run.evidence");
  if (run.metadata !== undefined) assertObject(run.metadata, "run.metadata");
  assertString(run.started_at, "run.started_at");
  assertString(run.updated_at, "run.updated_at");
  return true;
}

function validateReview(review) {
  assertObject(review, "review");
  assertString(review.task_id, "review.task_id");
  assertString(review.reviewer, "review.reviewer");
  assertString(review.owner, "review.owner");
  assertString(review.verdict, "review.verdict");
  if (!REVIEW_VERDICTS.has(review.verdict)) throw new Error(`invalid review.verdict: ${review.verdict}`);
  assertArray(review.required_fixes, "review.required_fixes");
  assertArray(review.optional_suggestions, "review.optional_suggestions");
  assertArray(review.questions, "review.questions");
  return true;
}

function validateProofManifest(manifest) {
  assertObject(manifest, "proof manifest");
  assertString(manifest.task_id, "manifest.task_id");
  assertString(manifest.tree_hash, "manifest.tree_hash");
  assertString(manifest.merge_ref, "manifest.merge_ref");
  assertArray(manifest.commands, "manifest.commands");
  for (const command of manifest.commands) {
    assertObject(command, "manifest.commands[]");
    assertString(command.cmd, "manifest.commands[].cmd");
    if (typeof command.exit_code !== "number") {
      throw new Error("manifest.commands[].exit_code must be number");
    }
  }
  assertObject(manifest.artifacts, "manifest.artifacts");
  assertArray(manifest.artifacts.browser_runs || [], "manifest.artifacts.browser_runs");
  assertArray(manifest.artifacts.screenshots || [], "manifest.artifacts.screenshots");
  assertArray(manifest.artifacts.console_checks || [], "manifest.artifacts.console_checks");
  assertArray(manifest.artifacts.computer_runs || [], "manifest.artifacts.computer_runs");
  assertArray(manifest.waivers || [], "manifest.waivers");
  assertString(manifest.verdict, "manifest.verdict");
  if (!PROOF_VERDICTS.has(manifest.verdict)) throw new Error(`invalid manifest.verdict: ${manifest.verdict}`);
  return true;
}

module.exports = {
  FRONTEND_FACETS,
  validateGoal,
  validateTask,
  validateAttempt,
  validateRun,
  validateReview,
  validateProofManifest,
  validateFrontendContract,
  validateToolPermissions,
  validateAccelerationPolicy
};
