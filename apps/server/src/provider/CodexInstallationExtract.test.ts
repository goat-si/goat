import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import * as NodeZlib from "node:zlib";

import { installationError } from "./CodexInstallationRelease.ts";
import { extractCodexPackage } from "./CodexInstallationExtract.ts";
import { archive, makeHarness, terminalState } from "./CodexInstallation.testkit.ts";

/** A gzipped ustar archive of one-byte regular files, so member names are exactly as given. */
const tarOf = (names: ReadonlyArray<string>) => {
  const blocks = names.flatMap((name) => {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write("00000000001\0", 124);
    header.write("00000000000\0", 136);
    header.fill(" ", 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    const body = Buffer.alloc(512);
    body.write("x");
    return [header, body];
  });
  return NodeZlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
};

const extractWith = (maxExtractedBytes?: number, packageBytes: Uint8Array = archive) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-codex-extract-" });
    const archivePath = path.join(directory, "download.tar.gz");
    const runtime = path.join(directory, "runtime");
    yield* fs.writeFile(archivePath, packageBytes);
    yield* fs.makeDirectory(runtime);
    const run = (command: string, args: ReadonlyArray<string>) =>
      spawner
        .string(ChildProcess.make(command, args))
        .pipe(Effect.mapError((cause) => installationError("extract", "tar failed", cause)));
    const result = yield* extractCodexPackage({
      fs,
      path,
      spawner,
      platform: "darwin",
      environment: { PATH: process.env.PATH },
      run,
      archivePath,
      runtime,
      ...(maxExtractedBytes === undefined ? {} : { maxExtractedBytes }),
    }).pipe(Effect.exit);
    const files = yield* fs.readDirectory(runtime, { recursive: true });
    return { error: Exit.isFailure(result) ? Cause.squash(result.cause) : undefined, files };
  }).pipe(Effect.scoped, Effect.orDie);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Codex package extraction", (it) => {
  it.effect("unpacks every member of a package within its size ceiling", () =>
    Effect.gen(function* () {
      const { error, files } = yield* extractWith();
      expect(error).toBeUndefined();
      expect([...files].sort()).toEqual(
        expect.arrayContaining(["bin/codex", "bin/codex-code-mode-host", "codex-path/rg"]),
      );
    }),
  );

  it.effect("stops unpacking once the package inflates past its ceiling", () =>
    Effect.gen(function* () {
      const { error } = yield* extractWith(1);
      expect(error).toMatchObject({
        detail: "The Codex package exceeded its unpacked size limit. Nothing was installed.",
      });
    }),
  );

  it.effect.each(["--to-command=sh", "-x", "bin/*", "bin/code?", "bin/[a]"])(
    "refuses a member tar would read as an option or a pattern (%s) before unpacking anything",
    (name) =>
      Effect.gen(function* () {
        const { error, files } = yield* extractWith(undefined, tarOf(["bin/codex", name]));
        expect(error).toMatchObject({ detail: "The Codex archive contains unsafe entries." });
        expect(files).toEqual([]);
      }),
  );
});

it.effect("a tar that stalls while unpacking ends the install with nothing activated", () =>
  Effect.gen(function* () {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner;
    const unpacking = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.args[0] === "-xOzf"
        ? Deferred.succeed(unpacking, undefined).pipe(
            Effect.as(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(4243),
                exitCode: Effect.never,
                isRunning: Effect.succeed(true),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.never,
                stderr: Stream.never,
                all: Stream.never,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            ),
          )
        : real.spawn(command),
    );
    const h = yield* makeHarness({ spawner });
    yield* h.installation.start;
    yield* Deferred.await(unpacking);
    yield* TestClock.adjust("10 minutes");
    expect(yield* terminalState(h.installation)).toMatchObject({
      phase: "failed",
      installedVersion: null,
      message: "Unpacking Codex took too long. Nothing was installed.",
    });
    expect(yield* h.fs.exists(`${h.baseDir}/tools/codex/active.json`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
