import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";

import { SshLaunchError } from "./errors.ts";
import { readLocalRuntimeArchive } from "./runtimeArchive.ts";

describe("local runtime archive", () => {
  it.effect("reads binary archive bytes and hashes without sidecars", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFile(`${root}/goat-1.2.3-linux-x64.tar.gz`, new Uint8Array([0, 128, 255]));
      const archive = yield* readLocalRuntimeArchive(root, "1.2.3", "linux-x64");
      assert.isNotNull(archive);
      assert.deepEqual(archive?.bytes, new Uint8Array([0, 128, 255]));
      assert.equal(
        archive?.sha256,
        "5240672d7b51756b829ad0ef8d9468b7a078afa2f410484fd3892dab47becb72",
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("returns null only for a missing archive", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      assert.isNull(yield* readLocalRuntimeArchive(root, "1.2.3", "linux-x64"));
      assert.isNull(yield* readLocalRuntimeArchive(root, "1.2.3", "linux-x64", true));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(["directory", "oversized", "changed", "grew past cap"] as const)(
    "rejects a %s archive",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const file = `${root}/goat-1.2.3-linux-x64.tar.gz`;
        yield* fs.writeFile(file, new Uint8Array([0]));
        const info = yield* fs.stat(file);
        let reads = 0;
        const fake = FileSystem.FileSystem.of({
          ...fs,
          stat: () =>
            Effect.succeed({
              ...info,
              type: mode === "directory" ? "Directory" : "File",
              size: ByteSize.bytes(mode === "oversized" ? 268435457 : mode === "changed" ? 2 : 1),
            }),
          readFile: () =>
            Effect.sync(() => {
              reads++;
              return mode === "grew past cap" ? new Uint8Array(268435457) : new Uint8Array([0]);
            }),
        });
        const result = yield* Effect.result(
          readLocalRuntimeArchive(root, "1.2.3", "linux-x64").pipe(
            Effect.provideService(FileSystem.FileSystem, fake),
          ),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.instanceOf(result.failure, SshLaunchError);
        assert.equal(reads, mode === "directory" || mode === "oversized" ? 0 : 1);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("read-only bundled archive checksum", () => {
  it.effect.each(["valid", "missing", "malformed", "noncanonical", "mismatch"] as const)(
    "requires a canonical sidecar (%s)",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const name = "goat-1.2.3-linux-x64.tar.gz";
        const bytes = new Uint8Array([0, 128, 255]);
        yield* fs.writeFile(`${root}/${name}`, bytes);
        const valid = "5240672d7b51756b829ad0ef8d9468b7a078afa2f410484fd3892dab47becb72";
        if (mode !== "missing")
          yield* fs.writeFileString(
            `${root}/${name}.sha256`,
            mode === "valid"
              ? `${valid}  ${name}\n`
              : mode === "noncanonical"
                ? `${valid} *${name}\n`
                : mode === "malformed"
                  ? "bad"
                  : `${"0".repeat(64)}  ${name}\n`,
          );
        const result = yield* Effect.result(
          readLocalRuntimeArchive(root, "1.2.3", "linux-x64", true),
        );
        assert.equal(Result.isFailure(result), mode !== "valid");
        if (Result.isSuccess(result)) assert.deepEqual(result.success?.bytes, bytes);
        assert.deepEqual(yield* fs.readFile(`${root}/${name}`), bytes);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
