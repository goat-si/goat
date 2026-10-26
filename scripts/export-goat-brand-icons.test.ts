import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  applyIconOutputs,
  exportGoatIcons,
  renderGoatIconOutputs,
} from "./export-goat-brand-icons.ts";

describe("GOAT brand icon check", () => {
  it.effect("reports stale raster and SVG/XML outputs without changing the output tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathApi = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-brand-icons-" });
      const outputs = yield* Effect.promise(() =>
        renderGoatIconOutputs(pathApi.resolve(import.meta.dirname, "..")),
      );
      assert.equal(
        yield* Effect.promise(() => applyIconOutputs(outputs, root, false, () => {})),
        0,
      );
      assert.equal(yield* Effect.promise(() => exportGoatIcons(root, true, () => {})), 0);
      const paths = [
        "assets/dev/blueprint-universal-1024.png",
        "apps/mobile/modules/goat-agent-notifications/android/src/main/res/drawable/agent_activity_mark.xml",
      ];
      for (const path of paths)
        yield* fs.writeFileString(pathApi.join(root, path), `stale ${path}`);
      const before = yield* Effect.forEach([...outputs.keys()], (path) =>
        fs.readFile(pathApi.join(root, path)),
      );
      const messages: string[] = [];
      assert.equal(
        yield* Effect.promise(() =>
          exportGoatIcons(root, true, (message) => messages.push(message)),
        ),
        1,
      );
      for (const path of paths) assert.include(messages, `stale ${path}`);
      const after = yield* Effect.forEach([...outputs.keys()], (path) =>
        fs.readFile(pathApi.join(root, path)),
      );
      assert.deepEqual(after, before);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
