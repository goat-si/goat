import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";

const WEB_ICON_FILENAMES = [
  "apple-touch-icon.png",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon.ico",
];

it.layer(NodeServices.layer)("apply-web-brand-assets", (it) => {
  it.effect("copies the icons into an absolute target directory as given", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "apply-web-brand-assets-",
      });
      const guarded = FileSystem.layerNoop({
        copyFile: (source, destination) =>
          path.dirname(destination) === targetDirectory
            ? fs.copyFile(source, destination)
            : Effect.die(`Copy escaped the test directory: ${destination}`),
      });
      yield* applyWebBrandAssets("production", targetDirectory).pipe(Effect.provide(guarded));
      assert.deepStrictEqual(
        (yield* fs.readDirectory(targetDirectory)).toSorted(),
        WEB_ICON_FILENAMES,
      );
    }),
  );

  it.effect("resolves an empty target directory to the repo root", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const destinations: string[] = [];
      // An empty target names the checkout root, so record copies without writing there.
      const copies = FileSystem.layerNoop({
        copyFile: (_source, destination) =>
          Effect.sync(() => {
            destinations.push(destination);
          }),
      });
      yield* applyWebBrandAssets("production", "").pipe(Effect.provide(copies));
      assert.deepStrictEqual(
        destinations.toSorted(),
        WEB_ICON_FILENAMES.map((filename) => path.join(repoRoot, filename)).toSorted(),
      );
    }),
  );
});
