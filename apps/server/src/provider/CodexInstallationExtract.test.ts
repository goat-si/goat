import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { installationError } from "./CodexInstallationRelease.ts";
import { extractCodexPackage } from "./CodexInstallationExtract.ts";
import { archive } from "./CodexInstallation.testkit.ts";

const extractWith = (maxExtractedBytes?: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-codex-extract-" });
    const archivePath = path.join(directory, "download.tar.gz");
    const runtime = path.join(directory, "runtime");
    yield* fs.writeFile(archivePath, archive);
    yield* fs.makeDirectory(runtime);
    const run = (command: string, args: ReadonlyArray<string>) =>
      spawner
        .string(ChildProcess.make(command, args))
        .pipe(Effect.mapError((cause) => installationError("extract", "tar failed", cause)));
    yield* extractCodexPackage({
      fs,
      path,
      spawner,
      platform: "darwin",
      environment: { PATH: process.env.PATH },
      run,
      archivePath,
      runtime,
      ...(maxExtractedBytes === undefined ? {} : { maxExtractedBytes }),
    });
    return yield* fs.readDirectory(runtime, { recursive: true });
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("Codex package extraction", (it) => {
  it.effect("unpacks every member of a package within its size ceiling", () =>
    Effect.gen(function* () {
      const files = yield* extractWith();
      expect([...files].sort()).toEqual(
        expect.arrayContaining(["bin/codex", "bin/codex-code-mode-host", "codex-path/rg"]),
      );
    }),
  );

  it.effect("stops unpacking once the package inflates past its ceiling", () =>
    Effect.gen(function* () {
      const error = yield* extractWith(1).pipe(Effect.flip);
      expect(error).toMatchObject({
        detail: "The Codex package exceeded its unpacked size limit. Nothing was installed.",
      });
    }),
  );
});
