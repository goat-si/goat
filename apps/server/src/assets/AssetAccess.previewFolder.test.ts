import { it, expect } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import { layerTest } from "./AssetAccess.testkit.ts";

it.effect.skipIf(!symlinksSupported)(
  "serves an HTML preview's files from the page's own folder only",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const site = path.join(root, "site");
      for (const directory of ["site/img", "src", "templates"]) {
        yield* fs.makeDirectory(path.join(root, directory), { recursive: true });
      }
      for (const name of [
        "site/page.html",
        "site/app.js",
        "site/img/logo.png",
        "src/main.js",
        "templates/page.html",
      ]) {
        yield* fs.writeFileString(path.join(root, name), "fixture");
      }
      yield* fs.symlink(path.join(root, "src", "main.js"), path.join(site, "main.js"));
      yield* fs.symlink(path.join(root, "src"), path.join(site, "vendor"));
      yield* fs.symlink(path.join(site, "app.js"), path.join(site, "alias.js"));
      yield* fs.symlink(path.join(root, "templates", "page.html"), path.join(site, "linked.html"));

      const tokenFor = Effect.fn(function* (entry: string) {
        const result = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: path.join(site, entry),
          },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(ASSET_ROUTE_PREFIX.length + 1);
        return suffix.slice(0, suffix.indexOf("/"));
      });
      const token = yield* tokenFor("page.html");
      for (const name of ["page.html", "app.js", "alias.js", "img/logo.png"]) {
        expect(yield* resolveAsset(token, name), name).toMatchObject({ kind: "file" });
      }
      for (const name of ["main.js", "vendor/main.js", "linked.html"]) {
        expect(yield* resolveAsset(token, name), name).toBeNull();
      }

      // The opened page may itself be a link; the files it loads still come from its folder.
      const linkedToken = yield* tokenFor("linked.html");
      expect(yield* resolveAsset(linkedToken, "linked.html")).toMatchObject({
        path: yield* fs.realPath(path.join(root, "templates", "page.html")),
      });
      expect(yield* resolveAsset(linkedToken, "app.js")).toMatchObject({ kind: "file" });
      expect(yield* resolveAsset(linkedToken, "main.js")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
);
