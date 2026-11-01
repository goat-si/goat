import * as Console from "effect/Console";
import { Command } from "effect/cli";

import { MCP_CLIENT_SKILL } from "./mcpClientSkill.ts";

// Console.log adds the newline the file ends with, so `goat mcp skill > SKILL.md` copies it exactly.
const mcpSkillCommand = Command.make("skill").pipe(
  Command.withDescription(
    "Print the guide for connecting an MCP client to GOAT, as an installable SKILL.md.",
  ),
  Command.withHandler(() => Console.log(MCP_CLIENT_SKILL.trimEnd())),
);

export const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("Connect MCP clients that GOAT did not start to this environment."),
  Command.withSubcommands([mcpSkillCommand]),
);
