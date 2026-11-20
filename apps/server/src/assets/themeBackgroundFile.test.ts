import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  readThemeBackground,
  openThemeBackground,
  readOpenedThemeBackground,
  closeThemeBackground,
} from "./themeBackgroundFile.ts";
import { PUBLISHED_BACKGROUND_MAX_BYTES } from "./publishedBackgroundBudget.ts";

it.layer(NodeServices.layer)("theme background image validation", (it) => {
  it.effect("rejects wrong magic, SVG, oversized images and symlinked files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-image-" });
        const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
        yield* fs.writeFile(path.join(dir, "wrong.jpg"), png);
        assert.isNull(yield* Effect.promise(() => readThemeBackground(dir, "wrong", "{}")));
        yield* fs.writeFileString(
          path.join(dir, "vector.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        );
        assert.isNull(yield* Effect.promise(() => readThemeBackground(dir, "vector", "{}")));
        const oversized = new Uint8Array(PUBLISHED_BACKGROUND_MAX_BYTES + 1);
        oversized.set(png);
        yield* fs.writeFile(path.join(dir, "large.png"), oversized);
        assert.isNull(yield* Effect.promise(() => readThemeBackground(dir, "large", "{}")));
        yield* fs.writeFile(path.join(dir, "real.png"), png);
        yield* fs.symlink(path.join(dir, "real.png"), path.join(dir, "link.png"));
        assert.isNull(yield* Effect.promise(() => readThemeBackground(dir, "link", "{}")));
        const good = yield* Effect.promise(() => readThemeBackground(dir, "real", "{}"));
        assert.equal(good?.mimeType, "image/png");
        yield* fs.writeFile(path.join(dir, "photo.jpg"), Uint8Array.from([0xff, 0xd8, 0xff, 0, 0]));
        assert.equal(
          (yield* Effect.promise(() => readThemeBackground(dir, "photo", "{}")))?.mimeType,
          "image/jpeg",
        );
        yield* fs.writeFile(
          path.join(dir, "web.webp"),
          Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
        );
        assert.equal(
          (yield* Effect.promise(() => readThemeBackground(dir, "web", "{}")))?.mimeType,
          "image/webp",
        );
        const opened = yield* Effect.promise(() => openThemeBackground(dir, "real", "png"));
        assert.isNotNull(opened);
        try {
          yield* fs.rename(path.join(dir, "real.png"), path.join(dir, "old.png"));
          yield* fs.writeFile(path.join(dir, "real.png"), png);
          assert.isNull(yield* Effect.promise(() => readOpenedThemeBackground(opened!, "{}")));
        } finally {
          yield* Effect.promise(() => closeThemeBackground(opened!));
        }
      }),
    ),
  );
});
