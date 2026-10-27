// @effect-diagnostics nodeBuiltinImport:off - the fixture hashes archive bytes it builds.
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@goat/shared/HostProcess";
import type { OpenCodexReleaseCatalog } from "@goat/shared/opencodexRelease";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as Installation from "./OpenCodexInstallation.ts";

export const TARGET = "bun-linux-x64";
export const urlOf = (version: string) => `https://fixture.invalid/ocx-${version}.tar.gz`;
export const fakeOcx = (version: string) =>
  `#!/bin/sh\n[ "$1" = --version ] && echo 'opencodex ${version}'\nexit 0\n`;

interface Archive {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/**
 * A home behind a symlink, as macOS temp directories are, plus a user bin on PATH. The filesystem
 * answers `exists` only inside the test root, so this machine's own OpenCodex is never selected.
 */
export const makeWorld = Effect.fn("OpenCodexInstallationTest.world")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ocx-install-" });
  const realHome = path.join(root, "real-home");
  const home = path.join(root, "home");
  const userBin = path.join(root, "user-bin");
  yield* fs.makeDirectory(realHome);
  yield* fs.makeDirectory(userBin);
  yield* fs.symlink(realHome, home);
  const resolvedHome = yield* fs.realPath(home);
  const prefix = path.join(resolvedHome, ".local", "share", "goat", "opencodex");
  const launcher = path.join(resolvedHome, ".local", "bin", "ocx");
  let archives = 0;
  /** Builds an archive from a standalone layout; `edit` changes the staged tree first. */
  const archive = (
    version: string,
    options: {
      readonly edit?: (stage: string) => Effect.Effect<void, PlatformError.PlatformError>;
      readonly members?: ReadonlyArray<string>;
    } = {},
  ) =>
    Effect.gen(function* () {
      const stage = path.join(root, `stage-${archives}`, "tree");
      const output = path.join(root, `stage-${archives++}`, "ocx.tar.gz");
      yield* fs.makeDirectory(path.join(stage, "gui", "dist"), { recursive: true });
      yield* fs.makeDirectory(path.join(stage, "keyring"));
      yield* fs.writeFileString(path.join(stage, "ocx"), fakeOcx(version), { mode: 0o755 });
      yield* fs.writeFileString(path.join(stage, "gui", "dist", "index.html"), "<html></html>");
      yield* fs.writeFileString(path.join(stage, "keyring", "keyring.node"), "native");
      if (options.edit) yield* options.edit(stage);
      const tar = yield* runner.run({
        command: "tar",
        args: ["-czPf", output, ...(options.members ?? ["ocx", "gui", "keyring"])],
        cwd: stage,
      });
      if (tar.code !== 0) return yield* Effect.die(tar.stderr);
      const bytes = yield* fs.readFile(output);
      const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      return { bytes, sha256 } satisfies Archive;
    }).pipe(Effect.orDie);
  const pin = (
    version: string,
    built: Archive,
    change: { sha256?: string; bytes?: number } = {},
  ) => ({
    [version]: {
      "linux-x64": {
        version,
        target: TARGET,
        url: urlOf(version),
        sha256: change.sha256 ?? built.sha256,
        archiveBytes: change.bytes ?? built.bytes.byteLength,
        publishedAt: "2026-10-24T00:00:00Z",
        layout: { executable: "ocx", gui: "gui/dist/index.html", keyring: "keyring" },
        remoteLinkWindows: false,
      },
    },
  });
  const downloads: Array<string> = [];
  /** The installer as production builds it, with the download and catalog at the boundary. */
  const installer = (
    catalog: OpenCodexReleaseCatalog,
    served: Readonly<Record<string, Uint8Array>>,
    hooks: {
      readonly beforeDownload?: Effect.Effect<void>;
      readonly extract?: Effect.Effect<never>;
    } = {},
  ) =>
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      const realRunner = yield* ProcessRunner.ProcessRunner;
      const sandboxed: FileSystem.FileSystem = {
        ...real,
        exists: (file) => (file.startsWith(root) ? real.exists(file) : Effect.succeed(false)),
      };
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          downloads.push(request.url);
          if (hooks.beforeDownload) yield* hooks.beforeDownload;
          const bytes = served[request.url];
          return HttpClientResponse.fromWeb(
            request,
            new Response(bytes ? new Blob([new Uint8Array(bytes)]) : null, {
              status: bytes ? 200 : 404,
            }),
          );
        }),
      );
      const extract = hooks.extract;
      const context = yield* Layer.build(
        Installation.layer.pipe(
          Layer.provide(Layer.succeed(FileSystem.FileSystem, sandboxed)),
          Layer.provide(
            Layer.succeed(
              ProcessRunner.ProcessRunner,
              ProcessRunner.ProcessRunner.of({
                run: (input) =>
                  extract !== undefined && input.args[0] === "-xf"
                    ? extract
                    : realRunner.run(input),
              }),
            ),
          ),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
          Layer.provide(Layer.succeed(Installation.ReleaseCatalog, catalog)),
          Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
          Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
          Layer.provide(Layer.succeed(HostProcess.Architecture, "x64")),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, root)),
          Layer.provide(
            Layer.succeed(HostProcess.Environment, {
              HOME: home,
              PATH: `${userBin}:/usr/bin:/bin`,
            }),
          ),
        ),
      );
      return Context.get(context, Installation.OpenCodexInstallation);
    });
  /** An executable a person installed themselves, outside anything GOAT owns. */
  const userOcx = (file: string, version: string) =>
    fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(file, fakeOcx(version), { mode: 0o755 })));
  const desktop = path.join(home, ".opencodex-desktop", "bin", "ocx");
  const releaseDirectories = fs
    .readDirectory(prefix)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  return {
    fs,
    path,
    root,
    home,
    resolvedHome,
    prefix,
    launcher,
    userBin,
    desktop,
    downloads,
    archive,
    pin,
    installer,
    userOcx,
    releaseDirectories,
  };
});

/** A world with 2.92.0 already installed and selected by GOAT. */
export const installedWorld = Effect.fn("OpenCodexInstallationTest.installedWorld")(function* () {
  const world = yield* makeWorld();
  const first = yield* world.archive("2.92.0");
  const next = yield* world.archive("2.93.0");
  const catalog = { ...world.pin("2.92.0", first), ...world.pin("2.93.0", next) };
  const served = { [urlOf("2.92.0")]: first.bytes, [urlOf("2.93.0")]: next.bytes };
  const service = yield* world.installer(catalog, served);
  const installed = yield* service.install();
  return { ...world, first, next, catalog, served, service, installed };
});
