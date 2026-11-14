import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

it.effect("refuses to index a workspace rooted at the home directory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "goat-search-home-" }),
      );
      yield* fs.makeDirectory(path.join(home, "OneDrive", "Remix"), { recursive: true });
      yield* fs.writeFileString(path.join(home, "OneDrive", "Remix", "part.stl"), "solid part\n");
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          vi.stubEnv("HOME", home);
          vi.stubEnv("USERPROFILE", home);
        }),
        () => Effect.sync(() => vi.unstubAllEnvs()),
      );
      const result = yield* WorkspaceSearchIndex.make(home).pipe(
        Effect.flatMap((searchIndex) => searchIndex.search("stl", 50, undefined, false)),
        Effect.map(({ entries }) => entries),
        Effect.catchTags({
          WorkspaceSearchIndexCreateFailed: (error) => Effect.succeed(error._tag),
        }),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      expect(result).toBe("WorkspaceSearchIndexCreateFailed");
    }),
  ).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
