import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  readClaudeAppendSystemPromptFile,
  readClaudeLaunchArgSettings,
} from "./ClaudeLaunchArgs.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.effect("expands home-relative Claude settings and prompt files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(home, "rules.txt"), "from home");
      yield* fs.writeFileString(path.join(home, "settings.json"), '{"model":"example"}');
      const settings = decodeClaudeSettings({
        launchArgs: "--settings ~/settings.json --append-system-prompt-file ~/rules.txt",
      });
      const input = { settings, cwd: "/workspace", fileSystem: fs, path };
      assert.deepEqual(
        yield* readClaudeLaunchArgSettings(input).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
        ),
        { model: "example" },
      );
      assert.equal(
        yield* readClaudeAppendSystemPromptFile(input).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
        ),
        "from home",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
