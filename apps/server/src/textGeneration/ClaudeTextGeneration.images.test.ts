import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { SYNTHETIC_CLAUDE_STANDARD_MODEL } from "../provider/ClaudeModelCatalog.testFixtures.ts";
import {
  layerClaudeTextGenerationTest,
  withFakeClaudeEnv,
} from "./ClaudeTextGeneration.testkit.ts";

it.layer(layerClaudeTextGenerationTest)("ClaudeTextGeneration images", (it) => {
  it.effect("sends image attachments to Claude, not only their metadata", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { branch: "fix/login-button" } }),
        stdinMustContain: Buffer.from("hello").toString("base64"),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-1-claude-attachment";
          const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(imagePath, Buffer.from("hello"));
          yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "fix this",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "screen.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            })
            .pipe(Effect.ensuring(fs.remove(imagePath).pipe(Effect.ignore)));
        }),
    ),
  );
});
