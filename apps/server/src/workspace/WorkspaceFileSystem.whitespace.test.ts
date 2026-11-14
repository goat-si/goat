import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
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

const known = Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void });
const layer = Layer.empty.pipe(
  Layer.provideMerge(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(known),
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
    ),
  ),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "goat-whitespace-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer, { excludeTestServices: true })("workspace whitespace paths", (it) => {
  it.effect(
    "reads and writes padded filenames without touching the unpadded file or escaping the root",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "goat-whitespace-" });
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "goat-whitespace-outside-" });
        yield* fs.writeFileString(path.join(cwd, "report.txt"), "ordinary");
        const names =
          HostProcess.Platform.defaultValue() === "win32"
            ? [" report.txt"]
            : [" report.txt", "report.txt ", "\treport.txt\t", " "];
        for (const relativePath of names) {
          yield* fs.writeFileString(path.join(cwd, relativePath), "padded");
          yield* fs.writeFileString(path.join(outside, relativePath), "outside");
          const read = yield* workspace.readFile({ cwd, relativePath });
          expect(read.relativePath).toBe(relativePath);
          expect(read.contents).toBe("padded");
          const absolute = path.join(outside, relativePath);
          expect((yield* workspace.readFile({ cwd, relativePath: absolute })).contents).toBe(
            "outside",
          );
          expect(
            (yield* workspace.writeFile({ cwd, relativePath, contents: "edited" })).relativePath,
          ).toBe(relativePath);
          expect(yield* fs.readFileString(path.join(cwd, relativePath))).toBe("edited");
        }
        expect(yield* fs.readFileString(path.join(cwd, "report.txt"))).toBe("ordinary");
        for (const relativePath of ["../escape.md", "../escape.md ", " folder/../../escape.md"]) {
          const error = yield* workspace
            .writeFile({ cwd, relativePath, contents: "no" })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        }
      }),
  );
});
