const paths = require("./paths");
const { writeJson, writeText } = require("./fsutil");

function policy(goalId) {
  return {
    goal_id: goalId || null,
    mailbox_is_truth: true,
    rules: [
      {
        area: "mailbox bodies",
        retain_until: "GOAL_REPORT.md generated and the human approves any compaction",
        compaction: "May replace large bodies with sha256 + report reference only after explicit retention command approval."
      },
      {
        area: "receipt_ack rows",
        retain_until: "goal closeout plus report generation",
        compaction: "May collapse duplicate receipt ACK display, but keep canonical JSONL rows unless explicit pruning is requested."
      },
      {
        area: "live-channel request/response rows",
        retain_until: "matching mailbox reply is imported or the goal report records why it was abandoned",
        compaction: "Live channel is audit/diagnostic only; never source of truth over mailbox."
      },
      {
        area: "proof artifacts",
        retain_until: "forever by default",
        compaction: "No deletion of screenshots, browser runs, console captures, or computer-use proof unless the human explicitly asks."
      },
      {
        area: "generated projections",
        retain_until: "regenerable",
        compaction: "Can be regenerated from state, but reports must preserve the exact proof paths they cite."
      }
    ],
    replayability: "A completed goal report must be understandable from canonical state, mailbox summaries, proof manifests, and artifact paths after compaction.",
    deletion_policy: "This command does not delete anything."
  };
}

function renderPolicy(record) {
  const lines = [
    "# Agent Team Retention Policy",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Goal: ${record.goal_id || "workspace"}`,
    "",
    "Mailbox is the source of truth. Live-channel rows are opportunistic diagnostics.",
    "",
    "## Rules",
    ""
  ];
  for (const rule of record.rules) {
    lines.push(`### ${rule.area}`);
    lines.push("");
    lines.push(`- Retain until: ${rule.retain_until}`);
    lines.push(`- Compaction: ${rule.compaction}`);
    lines.push("");
  }
  lines.push("## Replayability", "", record.replayability, "", "## Deletion", "", record.deletion_policy);
  return lines.join("\n");
}

function writeRetentionPolicy(cwd, options = {}) {
  const record = policy(options.goal_id);
  writeJson(paths.retentionManifestPath(cwd), record);
  writeText(paths.retentionPolicyPath(cwd), renderPolicy(record));
  return {
    ok: true,
    policy: record,
    manifest_path: paths.retentionManifestPath(cwd),
    markdown_path: paths.retentionPolicyPath(cwd)
  };
}

module.exports = {
  policy,
  renderPolicy,
  writeRetentionPolicy
};
