# Legacy daemon workflow

The `agent-team start --daemon`, `channel`, task-board, and global MCP installer commands predate the native cmux team workflow. They remain in the repository for existing installations. New users should start with the [README quickstart](../README.md#quickstart) and [native team guide](cmux-team.md).

The legacy path uses a receiver daemon and separate Claude and Codex MCP adapters. Its bundled installer and skill files configure that older path. Do not mix its state or startup commands with a native cmux coordinator.

The complete legacy installation, channel, diagnostics, and task commands are preserved in the [README before the public cmux guide update](https://github.com/andrewnova/agent-team-harness/blob/86d4df8a57b8fd866a266e2dd953d482c55b412f/README.md).

To move new work to cmux, finish or stop the old sessions through their existing controls, keep their evidence, and use a separate native coordinator. The new starter does not migrate, stop, or delete legacy sessions.
