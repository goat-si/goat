import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const project = WorkspaceFileSystem.layer.pipe(
  Layer.provide(Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void })),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);
const testLayer = Layer.empty.pipe(
  Layer.provideMerge(project),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "goat-workspace-metadata-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer, { excludeTestServices: true })("protected metadata", (it) => {
  it.effect("does not reveal metadata for server state or secret files", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(config.secretsDir, { recursive: true });
      yield* fs.writeFileString(path.join(config.secretsDir, "example.bin"), "example\n");
      yield* fs.writeFileString(path.join(config.stateDir, "statev2.sqlite"), "example\n");
      const metadata = yield* service.getMetadata({
        paths: [
          path.join(config.secretsDir, "example.bin"),
          path.join(config.stateDir, "statev2.sqlite"),
          config.stateDir,
        ],
      });
      expect(metadata.entries).toEqual([null, null, { kind: "directory" }]);
    }),
  );
});
