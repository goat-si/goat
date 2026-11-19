import { expect, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import { layerTest } from "./AssetAccess.testkit.ts";

it.effect("validates canonical sibling assets for previews in dot-prefixed folders", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const reportsDirectory = path.join(root, ".reports");
    yield* fs.makeDirectory(path.join(reportsDirectory, ".cache"), { recursive: true });
    yield* fs.makeDirectory(path.join(root, ".secret"));
    const page = path.join(reportsDirectory, "report.html");
    yield* fs.writeFileString(page, "<!doctype html>");
    const css = path.join(reportsDirectory, "report.css");
    yield* fs.writeFileString(css, "body {} ");
    const dependencies = [
      { name: "linked.css", target: path.join(root, ".secret", "key.css"), allowed: false },
      {
        name: "inner.css",
        target: path.join(reportsDirectory, ".cache", "hidden.css"),
        allowed: false,
      },
      { name: "shared.css", target: path.join(root, "shared.css"), allowed: true },
    ];
    for (const { name, target } of dependencies) {
      yield* fs.writeFileString(target, "fixture");
      yield* fs.symlink(target, path.join(reportsDirectory, name));
    }
    const result = yield* issueAssetUrl({
      resource: { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: page },
      workspaceRoot: root,
    });
    const suffix = result.relativeUrl.slice(ASSET_ROUTE_PREFIX.length + 1);
    const token = suffix.slice(0, suffix.indexOf("/"));
    expect(yield* resolveAsset(token, "report.html")).toEqual({
      kind: "file",
      path: yield* fs.realPath(page),
    });
    expect(yield* resolveAsset(token, "report.css")).toEqual({
      kind: "file",
      path: yield* fs.realPath(css),
    });
    expect(yield* resolveAsset(token, ".cache/hidden.css")).toBeNull();
    for (const { name, target, allowed } of dependencies) {
      const resolved = yield* resolveAsset(token, name);
      if (allowed) {
        expect(resolved).toEqual({
          kind: "file",
          path: yield* fs.realPath(target),
        });
      } else {
        expect(resolved).toBeNull();
      }
    }
  }).pipe(Effect.provide(layerTest)),
);
