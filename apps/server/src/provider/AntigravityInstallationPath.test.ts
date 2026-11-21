import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { makeHarness } from "./AntigravityInstallation.testkit.ts";

it.effect("finds agy on PATH when no explicit executable is configured", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-agy-path-alias-" });
    const bin = path.join(baseDir, "bin");
    yield* fs.makeDirectory(bin);
    const alias = path.join(bin, "agy");
    yield* fs.writeFileString(alias, "cli", { mode: 0o755 });
    const { installation } = yield* makeHarness({ baseDir });
    expect(yield* installation.resolve(undefined, { PATH: bin })).toMatchObject({
      executablePath: alias,
      harnessPath: null,
      source: "path",
    });
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);
