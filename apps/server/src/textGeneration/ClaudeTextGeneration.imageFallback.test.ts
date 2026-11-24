import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { expect } from "vite-plus/test";
import { SYNTHETIC_CLAUDE_STANDARD_MODEL } from "../provider/ClaudeModelCatalog.testFixtures.ts";
import * as ServerConfig from "../config.ts";
import {
  layerClaudeTextGenerationTest,
  withFakeClaudeEnv,
} from "./ClaudeTextGeneration.testkit.ts";

it.layer(layerClaudeTextGenerationTest)("Claude image fallback", (it) => {
  it.effect.each(["unsupported", "reverse", "auth"] as const)(
    "handles image attempt with %s",
    (scenario) =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({ structured_output: { branch: "fix/login-button" } }),
          rejectsImages: scenario === "auth" ? "auth" : scenario === "reverse" ? "reverse" : true,
          expectSpawnCount: scenario === "auth" ? 1 : 3,
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const { attachmentsDir } = yield* ServerConfig.ServerConfig;
            const id = "thread-1-claude-text-only-attachment";
            const imagePath = path.join(attachmentsDir, `${id}.png`);
            yield* fs.makeDirectory(attachmentsDir, { recursive: true });
            yield* fs.writeFile(imagePath, Buffer.from("hello"));
            const result = yield* textGeneration
              .generateBranchName({
                cwd: process.cwd(),
                message: "fix this",
                attachments: [
                  { type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 5 },
                ],
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
                },
              })
              .pipe(Effect.ensuring(fs.remove(imagePath).pipe(Effect.ignore)), Effect.result);
            if (scenario === "auth") {
              expect(Result.isFailure(result)).toBe(true);
            } else {
              expect(Result.isSuccess(result)).toBe(true);
              if (Result.isSuccess(result)) expect(result.success.branch).toBe("fix/login-button");
              yield* fs.writeFile(imagePath, Buffer.from("hello"));
              const second = yield* textGeneration
                .generateBranchName({
                  cwd: process.cwd(),
                  message: "fix this",
                  attachments: [
                    { type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 5 },
                  ],
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("claudeAgent"),
                    model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
                  },
                })
                .pipe(Effect.ensuring(fs.remove(imagePath).pipe(Effect.ignore)));
              expect(second.branch).toBe("fix/login-button");
            }
          }),
      ),
  );
});
