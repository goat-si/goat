import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

export const openPiScreenSkillGate = (fileSystem: FileSystem.FileSystem) =>
  fileSystem.makeTempFileScoped({ prefix: "goat-pi-screen-skill-" });

export const writePiScreenSkillGate = Effect.fn("PiScreenSkillGate.write")(
  (
    fileSystem: FileSystem.FileSystem,
    path: string,
    attached: McpProviderSession.McpProviderSessionConfig | undefined,
  ) =>
    fileSystem.writeFileString(
      path,
      JSON.stringify({
        screenCode: McpProviderSession.carriesScreenCodeSkill(attached),
        browser: attached?.browserToolsAvailable === true,
      }),
    ),
);
