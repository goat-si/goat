import { FileFinder } from "@ff-labs/fff-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PROJECT_FAVICON_EXTENSIONS, isProjectFaviconPath } from "@goat/shared/projectFavicon";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

const testLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.live(
  "image search preserves mixed-case extensions, exclusions and ranking before pagination",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcs = yield* VcsProcess.VcsProcess;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "u25-image-search-" });
      yield* vcs.run({ operation: "test.gitInit", command: "git", args: ["init"], cwd });
      yield* fs.writeFileString(path.join(cwd, ".git/info/exclude"), "hidden/\n");
      const paths = [
        ...PROJECT_FAVICON_EXTENSIONS.map(
          (ext) => `assets/logo${[...ext].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join("")}`,
        ),
        "assets/logo.ts",
        "assets/logotype.png",
        "other/logo.PNG",
        "hidden/logo.svg",
        "assets/logo.heic",
        ...Array.from({ length: 40 }, (_, index) => `assets/source-${index}.ts`),
      ];
      for (const name of paths) {
        const file = path.join(cwd, name);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      using fileSearch = vi.spyOn(FileFinder.prototype, "fileSearchAsync");
      const index = yield* WorkspaceSearchIndex.make(cwd);
      const all = yield* index.search("", 100, "file", true);
      expect(all.entries.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(
          paths.filter((p) => p.startsWith("assets/logo") && isProjectFaviconPath(p)),
        ),
      );
      expect(
        all.entries.some(
          (entry) => entry.path.startsWith("hidden/") || entry.path.endsWith(".heic"),
        ),
      ).toBe(false);
      expect(fileSearch.mock.calls[0]?.[0]).toContain("**/*.{");
      for (const query of ["logo", "*.png", "!*.png", "assets/"]) {
        const ordinary = yield* index.search(query, 100, "file");
        const images = yield* index.search(query, 100, "file", true);
        expect(images.entries, query).toEqual(
          ordinary.entries.filter((entry) => isProjectFaviconPath(entry.path)),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("image search preserves fff ranking when filename fallback is disabled", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "u25-image-rank-" });
    yield* fs.makeDirectory(path.join(cwd, "b"));
    yield* fs.makeDirectory(path.join(cwd, "a"));
    yield* fs.makeDirectory(path.join(cwd, "x/logo"), { recursive: true });
    for (let i = 0; i < 14_998; i++) {
      yield* fs.writeFileString(path.join(cwd, `b/logo-${i}.png`), "");
    }
    for (const name of ["x/logo/source.ts", "a/xxlogo.png", "x/logo/logo.png"]) {
      yield* fs.writeFileString(path.join(cwd, name), "");
    }
    const index = yield* WorkspaceSearchIndex.make(cwd);
    const ordinary = yield* index.search("logo", 20_000, "file");
    const images = yield* index.search("logo", 20_000, "file", true);
    const pair = new Set(["a/xxlogo.png", "x/logo/logo.png"]);
    expect(images.entries).toHaveLength(15_000);
    expect(images.entries.filter((entry) => pair.has(entry.path))).toEqual(
      ordinary.entries.filter((entry) => pair.has(entry.path)),
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
