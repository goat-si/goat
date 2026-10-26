import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import type * as FileSystem from "effect/FileSystem";

export const openPiScreenSkillGate = (fileSystem: FileSystem.FileSystem) =>
  fileSystem.makeTempFileScoped({ prefix: "goat-pi-screen-skill-" });

export const writePiScreenSkillGate = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  attached: McpProviderSession.McpProviderSessionConfig | undefined,
) =>
  fileSystem.writeFileString(
    path,
    McpProviderSession.carriesScreenCodeSkill(attached) ? "on" : "off",
  );
