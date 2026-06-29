const { writeText } = require("./fsutil");
const paths = require("./paths");
const { listEvents, listGoals, listRuns, listTasks } = require("./state");
const { loadPlanSummary } = require("./plans");

function renderTaskMarkdown(task) {
  const criteria = task.acceptance_criteria.map((item) => `- ${item}`).join("\n") || "- None recorded";
  const allowed = task.allowed_paths.map((item) => `- ${item}`).join("\n") || "- None recorded";
  const forbidden = task.forbidden_paths.map((item) => `- ${item}`).join("\n") || "- None recorded";
  const commands = task.proof.commands.map((item) => `- \`${item}\``).join("\n") || "- None recorded";
  const goalPrompt = task.goal_prompt
    ? ["## Goal Prompt", "", "```text", task.goal_prompt, "```"].join("\n")
    : "";
  const ownerHistory = (task.owner_history || [])
    .map((item) => `- ${item.from || "none"} -> ${item.to}: ${item.reason}`)
    .join("\n") || "- None recorded";
  const toolPermissions = task.tool_permissions
    ? [
        `- Claude browser observation: ${Boolean(task.tool_permissions.claude_chrome_extension)}`,
        `- Codex browser proof authority: ${Boolean(task.tool_permissions.codex_browser_proof)}`
      ].join("\n")
    : "- None recorded";
  const accelerationPolicy = task.acceleration_policy
    ? [
        `- Execution profile: ${task.acceleration_policy.execution_profile}`,
        `- Codex subagents: ${task.acceleration_policy.codex_subagents}`,
        `- Claude Agent Teams: ${task.acceleration_policy.claude_agent_teams}`,
        `- Token budget: ${task.acceleration_policy.token_budget}`,
        `- Write isolation: ${task.acceleration_policy.write_isolation}`,
        `- Codex final authority: ${Boolean(task.acceleration_policy.codex_final_authority)}`
      ].join("\n")
    : "- None recorded";
  const frontend = task.frontend_contract
    ? [
        "## Frontend Contract",
        "",
        `Target flow: ${task.frontend_contract.target_flow}`,
        "",
        `Responsive states: ${task.frontend_contract.responsive_states.join(", ")}`,
        `Interaction states: ${task.frontend_contract.interaction_states.join(", ")}`,
        "",
        "Visual acceptance:",
        task.frontend_contract.visual_acceptance.map((item) => `- ${item}`).join("\n"),
        "",
        "Accessibility expectations:",
        task.frontend_contract.accessibility_expectations.map((item) => `- ${item}`).join("\n"),
        "",
        `Console check required: ${task.frontend_contract.console_check_required}`
      ].join("\n")
    : "";
  return [
    `# ${task.task_id}: ${task.title}`,
    "",
    `Status: ${task.status}`,
    `Owner: ${task.owner}`,
    `Reviewer: ${task.reviewer}`,
    `Goal: ${task.goal_id}`,
    `Facet: ${task.facet}`,
    "",
    "## Objective",
    "",
    task.objective,
    "",
    "## Acceptance Criteria",
    "",
    criteria,
    "",
    goalPrompt,
    "",
    "## File Scope",
    "",
    "Allowed:",
    allowed,
    "",
    "Forbidden:",
    forbidden,
    "",
    "## Proof",
    "",
    commands,
    "",
    `Requires browser: ${task.proof.requires_browser}`,
    `Requires screenshot: ${task.proof.requires_screenshot}`,
    "",
    "## Owner History",
    "",
    ownerHistory,
    "",
    "## Tool Permissions",
    "",
    toolPermissions,
    "",
    "## Acceleration Policy",
    "",
    accelerationPolicy,
    "",
    frontend
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function renderBoard(tasks) {
  const statuses = ["goal", "planning", "ready", "claimed", "implementing", "review", "merge", "verifying", "done", "handoff", "human", "blocked"];
  const sections = ["# Agent Team Board", ""];
  for (const status of statuses) {
    const rows = tasks.filter((task) => task.status === status);
    sections.push(`## ${status}`);
    sections.push("");
    if (rows.length === 0) {
      sections.push("- None");
    } else {
      for (const task of rows) {
        sections.push(`- ${task.task_id} [${task.owner} -> ${task.reviewer}] ${task.title}`);
      }
    }
    sections.push("");
  }
  return sections.join("\n");
}

function renderHealth(tasks, events = [], runs = []) {
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  const activeRuns = runs.filter((run) => run.status === "active").length;
  const latest = events
    .slice(-5)
    .map((event) => `- ${event.recorded_at} ${event.type}${event.task_id ? ` ${event.task_id}` : ""}${event.run_id ? ` ${event.run_id}` : ""}${event.goal_id && !event.task_id && !event.run_id ? ` ${event.goal_id}` : ""}`);
  return [
    "# Agent Team Health",
    "",
    `Tasks: ${tasks.length}`,
    `Runs: ${runs.length}`,
    `Active runs: ${activeRuns}`,
    `Events: ${events.length}`,
    "",
    ...Object.keys(counts)
      .sort()
      .map((status) => `- ${status}: ${counts[status]}`),
    "",
    "## Latest Events",
    "",
    ...(latest.length ? latest : ["- None"])
  ].join("\n");
}

function renderPlanMarkdown(goal, summary) {
  return [
    `# ${goal.goal_id}: ${goal.title}`,
    "",
    "## Objective",
    "",
    goal.objective,
    "",
    "## Planning State",
    "",
    `- Codex plan: ${summary.codex}`,
    `- Claude plan: ${summary.claude}`,
    `- Reconciled plan: ${summary.reconciled}`,
    `- Decision record: ${Boolean(summary.decision)}`,
    "",
    summary.decision
      ? [
          "## Decision",
          "",
          `Status: ${summary.decision.status}`,
          `Decided: ${summary.decision.decided_at}`,
          `Output: ${summary.decision.output}`
        ].join("\n")
      : "## Decision\n\nNone recorded"
  ].join("\n");
}

function regenerate(cwd) {
  const goals = listGoals(cwd);
  const tasks = listTasks(cwd);
  const runs = listRuns(cwd);
  const events = listEvents(cwd);
  for (const goal of goals) {
    writeText(paths.planProjectionPath(cwd, goal.goal_id), renderPlanMarkdown(goal, loadPlanSummary(cwd, goal.goal_id)));
  }
  for (const task of tasks) {
    writeText(paths.taskProjectionPath(cwd, task.task_id), renderTaskMarkdown(task));
  }
  writeText(paths.boardPath(cwd), renderBoard(tasks));
  writeText(paths.healthPath(cwd), renderHealth(tasks, events, runs));
  return { tasks: tasks.length, runs: runs.length, events: events.length };
}

module.exports = {
  renderTaskMarkdown,
  renderBoard,
  renderHealth,
  renderPlanMarkdown,
  regenerate
};
