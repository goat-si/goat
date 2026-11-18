import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveAutoCompactWindow } from "./ClaudeCompactSettings.ts";

it.effect("uses Claude's environment compact window from settings and process", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const file = path.join(home, "settings.json");
      yield* fileSystem.writeFileString(
        file,
        JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" } }),
      );
      const base = {
        configured: "",
        model: "claude-opus-5-5",
        launchSettings: undefined,
        fileSystem,
      };
      assert.equal(
        yield* resolveAutoCompactWindow({ ...base, files: [file], environment: {} }),
        "300000",
      );
      assert.equal(
        yield* resolveAutoCompactWindow({
          ...base,
          files: [],
          environment: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" },
        }),
        "300000",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
