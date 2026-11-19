import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import * as HostProcess from "./HostProcess.ts";
import { CommandResolutionCache, resolveCommandPath } from "./shell.ts";

it.effect("honors mixed-case PATHEXT when resolving Windows executables", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-pathext-" });
    yield* fs.writeFileString(path.join(dir, "audit.EXE"), "");
    yield* fs.writeFileString(path.join(dir, "audit.CMD"), "");
    const resolved = yield* resolveCommandPath("audit", {
      env: { PATH: dir, PathExt: ".CMD" },
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(CommandResolutionCache, new Map()),
    );
    expect(resolved).toBe(path.join(dir, "audit.CMD"));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
