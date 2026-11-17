import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { enableCliCompileCache } from "./cliCompileCache.ts";

// Runs the AppImage branch, which deletes and returns without enabling a cache in this process.
const launchAsAppImage = (root: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved = { APPIMAGE: process.env.APPIMAGE, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
      process.env.APPIMAGE = `${root}/GOAT.AppImage`;
      process.env.XDG_CACHE_HOME = `${root}/cache`;
      return saved;
    }),
    () => Effect.sync(enableCliCompileCache),
    (saved) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(saved))
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }),
  );

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-cli-cache-appimage-" });
  const cacheDir = `${root}/cache/goat/compile-cache`;
  // Holds what a deletion that followed a link would wrongly reach.
  const outside = `${root}/elsewhere`;
  yield* fs.makeDirectory(`${outside}/v24.0.0-x64-1000`, { recursive: true });
  yield* fs.writeFileString(`${outside}/v24.0.0-x64-1000/keep`, "outside the cache");
  return { fs, root, cacheDir, outside };
});

// Older AppImage shims cached anyway, and each launch's new mount path filled a new engine folder.
it.live("an AppImage launch deletes Node's versioned compile-cache folders", () =>
  Effect.gen(function* () {
    const { fs, root, cacheDir } = yield* fixture;
    yield* fs.makeDirectory(`${cacheDir}/v24.0.0-x64-legacy-1000`, { recursive: true });
    yield* fs.writeFileString(`${cacheDir}/v24.0.0-x64-legacy-1000/0123abcd`, "stale");
    yield* fs.makeDirectory(`${cacheDir}/v22.1.0-arm64-1001`);
    yield* fs.makeDirectory(`${cacheDir}/server`);
    yield* launchAsAppImage(root);
    expect(yield* fs.readDirectory(cacheDir)).toEqual(["server"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("an AppImage launch keeps a link named v1 and what it points to", () =>
  Effect.gen(function* () {
    const { fs, root, cacheDir, outside } = yield* fixture;
    yield* fs.makeDirectory(cacheDir, { recursive: true });
    yield* fs.symlink(`${outside}/v24.0.0-x64-1000`, `${cacheDir}/v1`);
    yield* launchAsAppImage(root);
    expect(yield* fs.readDirectory(cacheDir)).toEqual(["v1"]);
    expect(yield* fs.readFileString(`${outside}/v24.0.0-x64-1000/keep`)).toBe("outside the cache");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("an AppImage launch keeps a broken link named v1", () =>
  Effect.gen(function* () {
    const { fs, root, cacheDir } = yield* fixture;
    yield* fs.makeDirectory(cacheDir, { recursive: true });
    yield* fs.symlink(`${root}/gone`, `${cacheDir}/v1`);
    yield* launchAsAppImage(root);
    expect(yield* fs.readLink(`${cacheDir}/v1`)).toBe(`${root}/gone`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("an AppImage launch keeps a file named v1", () =>
  Effect.gen(function* () {
    const { fs, root, cacheDir } = yield* fixture;
    yield* fs.makeDirectory(cacheDir, { recursive: true });
    yield* fs.writeFileString(`${cacheDir}/v1`, "a file, not an engine folder");
    yield* launchAsAppImage(root);
    expect(yield* fs.readFileString(`${cacheDir}/v1`)).toBe("a file, not an engine folder");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.each(["goat", "goat/compile-cache"])(
  "an AppImage launch deletes nothing when cache/%s is a link",
  (linked) =>
    Effect.gen(function* () {
      const { fs, root, outside } = yield* fixture;
      yield* fs.makeDirectory(`${root}/cache/goat`, { recursive: true });
      // A linked goat folder must hold compile-cache for the link to lead to the outside folder.
      const target = linked === "goat" ? `${root}/linked-goat` : outside;
      if (linked === "goat") {
        yield* fs.remove(`${root}/cache/goat`, { recursive: true });
        yield* fs.makeDirectory(target);
        yield* fs.symlink(outside, `${target}/compile-cache`);
      }
      yield* fs.symlink(target, `${root}/cache/${linked}`);
      yield* launchAsAppImage(root);
      expect(yield* fs.readFileString(`${outside}/v24.0.0-x64-1000/keep`)).toBe(
        "outside the cache",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
