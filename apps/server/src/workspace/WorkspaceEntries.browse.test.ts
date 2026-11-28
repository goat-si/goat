import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const layer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "goat-browse-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer, { excludeTestServices: true })("WorkspaceEntries browse", (it) => {
  it.effect("lists numbered folders in natural order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "goat-workspace-browse-natural-" });
      for (const name of ["app10", "app2", "app1"]) yield* fs.makeDirectory(path.join(cwd, name));
      const entries = yield* WorkspaceEntries.WorkspaceEntries;
      const result = yield* entries.browse({ partialPath: `${cwd}${path.sep}` });
      expect(result.entries.map((entry) => entry.name)).toEqual(["app1", "app2", "app10"]);
    }),
  );
});
