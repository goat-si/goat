import { createHash } from "node:crypto";
import { it } from "@effect/vitest";
import { assert } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { stageManifestShell } from "./stage-manifest-shell.ts";

it.effect("capability marker binds the final signed executable bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "manifest-shell-stage-" });
    const exe = path.join(folder, "goat.exe");
    const bytes = new TextEncoder().encode("invented final signed executable bytes");
    yield* fs.writeFile(exe, bytes);
    yield* stageManifestShell(folder, exe, "1.2.3");
    assert.equal(
      yield* fs.readFileString(path.join(folder, "goat-manifest-shell-v1.sha256")),
      `1.2.3 ${createHash("sha256").update(bytes).digest("hex")}\n`,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
