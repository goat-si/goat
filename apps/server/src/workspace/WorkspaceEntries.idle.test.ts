import * as NodeServices from "@effect/platform-node/NodeServices";
import { FileFinder } from "@ff-labs/fff-node";
import { it, afterEach, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "goat-idle-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layerTest, { excludeTestServices: true })("WorkspaceEntries idle", (it) => {
  afterEach(() => vi.restoreAllMocks());
  it.effect("releases an index nobody searched within the idle timeout on refresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "goat-workspace-idle-refresh-" });
      yield* fs.writeFileString(`${cwd}/index.ts`, "");
      let rescans = 0;
      let destroyed = 0;
      const createFinder = FileFinder.create.bind(FileFinder);
      vi.spyOn(FileFinder, "create").mockImplementation((options) => {
        const created = createFinder(options);
        if (created.ok) {
          const finder = created.value;
          const scanFilesAsync = finder.scanFilesAsync.bind(finder);
          finder.scanFilesAsync = () => {
            rescans += 1;
            return scanFilesAsync();
          };
          const destroy = finder.destroyAsync.bind(finder);
          finder.destroyAsync = () => {
            destroyed += 1;
            return destroy();
          };
        }
        return created;
      });
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      yield* TestClock.adjust("1 hour");
      yield* workspaceEntries.search({ cwd, query: "index", limit: 10 });

      for (let run = 0; run < 3; run++) {
        yield* TestClock.adjust("6 minutes");
        yield* workspaceEntries.refresh(cwd);
      }

      expect({ rescans, destroyed }).toEqual({ rescans: 2, destroyed: 1 });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
