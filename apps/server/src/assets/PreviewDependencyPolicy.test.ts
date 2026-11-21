import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { resolveAsset } from "./AssetAccess.ts";
import { layerTest, scopedMediaFixture } from "./AssetAccess.testkit.ts";

it.effect("checks both requested and canonical preview dependency paths", () =>
  Effect.gen(function* () {
    const { fs, token, media } = yield* scopedMediaFixture();
    const path = yield* Path.Path;
    const root = path.dirname(media);
    yield* fs.writeFileString(path.join(root, ".secret.css"), "secret");
    yield* fs.writeFileString(path.join(root, "private.txt"), "secret");
    yield* fs.writeFileString(path.join(root, "allowed.css"), "body{}");
    yield* fs.symlink(path.join(root, ".secret.css"), path.join(root, "hidden.css"));
    yield* fs.symlink(path.join(root, "private.txt"), path.join(root, "renamed.css"));
    yield* fs.symlink(path.join(root, "allowed.css"), path.join(root, "visible.css"));
    expect(yield* resolveAsset(token, "visible.css")).toMatchObject({
      path: yield* fs.realPath(path.join(root, "allowed.css")),
    });
    expect(yield* resolveAsset(token, "hidden.css")).toBeNull();
    expect(yield* resolveAsset(token, "renamed.css")).toBeNull();
    expect(yield* resolveAsset(token, ".secret.css")).toBeNull();
    expect(yield* resolveAsset(token, "private.txt")).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
