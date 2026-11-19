import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readClaudeSubagentEffort } from "./ClaudeSubagentEffort.ts";

it.layer(NodeServices.layer)("Claude subagent transcript discovery", (it) => {
  it.effect("caps project probes for a missing transcript", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped();
      for (let i = 0; i < 150; i++) {
        yield* fs.makeDirectory(path.join(configDir, "projects", `project-${i}`), {
          recursive: true,
        });
      }
      let probes = 0;
      const effort = yield* readClaudeSubagentEffort({
        configDir,
        nativeSessionId: "missing",
        taskId: "missing",
        completed: false,
        path,
        fileSystem: {
          ...fs,
          exists: (file) => {
            probes++;
            return fs.exists(file);
          },
        },
      });
      assert.isUndefined(effort);
      assert.equal(probes, 128);
    }),
  );
});
