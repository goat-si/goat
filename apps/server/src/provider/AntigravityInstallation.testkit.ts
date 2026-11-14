import * as HostProcess from "@goat/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import type { AntigravityReleaseAsset } from "./antigravityRelease.ts";

export const serverContents = "antigravity runtime\n";
export const harnessContents = "local harness\n";
export const previousReleaseId = "1".repeat(64);
export const previousVersion = "fixture-old";
export const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const zipFixtures = {
  complete:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAAAAAAAAAAAAAO2BAAAAAGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAADtgUQAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCDAAAAhwAAAAAA",
  missingHarness:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwECFAMUAAAACAAAACJdcxMv6BQAAAAUAAAAEgAAAAAAAAAAAAAA7YEAAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsFBgAAAAABAAEAQAAAAEQAAAAAAA==",
  duplicate:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAABhZ3lfYWNwX3NlcnZlci5wYXJLzCvJTC9KLMssqVQoKgVyclO5AFBLAQIUAxQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5wYXJQSwECFAMUAAAACAAAACJdcxMv6BQAAAAUAAAAEgAAAAAAAAAAAAAA7YFEAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsFBgAAAAACAAIAgAAAAIgAAAAAAA==",
  traversal:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAAVAAAALi5cYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABUAAAAAAAAAAAAAAO2BAAAAAC4uXGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAADtgUcAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCGAAAAigAAAAAA",
  symlink:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAAAAAAAAAAAAAO2BAAAAAGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAAD/oUQAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCDAAAAhwAAAAAA",
  oversizedMember:
    "UEsDBBQAAAAIAAAAIl0WGThFFQAAABUAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuSoAUEsDBBQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsy8lPTsxRyEgsykstLuYCAFBLAQIUAxQAAAAIAAAAIl0WGThFFQAAABUAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5wYXJQSwECFAMUAAAACAAAACJdX3IDKRAAAAAOAAAAFQAAAAAAAAAAAAAA7YFFAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsUEsFBgAAAAACAAIAgwAAAIgAAAAAAA==",
  windows:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIuZXhlS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABkAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWwuZXhly8lPTsxRyEgsykstLuYCAFBLAQIUAxQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5leGVQSwECFAMUAAAACAAAACJdX3IDKRAAAAAOAAAAGQAAAAAAAAAAAAAA7YFEAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsLmV4ZVBLBQYAAAAAAgACAIcAAACLAAAAAAA=",
};

// Linux platform mocks cannot enforce POSIX exec bits on NTFS; use the host platform.
export const hostPlatform: NodeJS.Platform =
  HostProcess.Platform.defaultValue() === "win32" ? "win32" : "linux";
export const completeArchive = Buffer.from(
  hostPlatform === "win32" ? zipFixtures.windows : zipFixtures.complete,
  "base64",
);
export const executableName =
  hostPlatform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
export const harnessName =
  hostPlatform === "win32" ? "localharness_external.exe" : "localharness_external";

export const releaseAsset = Effect.fn("test.antigravityReleaseAsset")(function* (
  archive: Uint8Array = completeArchive,
  platform: NodeJS.Platform = hostPlatform,
) {
  const crypto = yield* Crypto.Crypto;
  return {
    version: "fixture-new",
    url: "https://dl.google.com/antigravity-test.zip",
    sha256: Hex.encode(yield* crypto.digest("SHA-256", archive).pipe(Effect.orDie)),
    archiveBytes: archive.byteLength,
    executable: {
      name: platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par",
      bytes: Buffer.byteLength(serverContents),
    },
    harness: {
      name: platform === "win32" ? "localharness_external.exe" : "localharness_external",
      bytes: Buffer.byteLength(harnessContents),
    },
  } satisfies AntigravityReleaseAsset;
});

export const writeRelease = Effect.fn("test.writeAntigravityRelease")(function* (
  managedDirectory: string,
  asset: AntigravityReleaseAsset,
  active = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(managedDirectory, "versions", asset.sha256);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, asset.executable.name), serverContents, {
    mode: 0o755,
  });
  yield* fs.writeFileString(path.join(directory, asset.harness.name), harnessContents, {
    mode: 0o755,
  });
  yield* fs.writeFileString(
    path.join(directory, ".install-complete.json"),
    encodeJsonString({
      releaseId: asset.sha256,
      version: asset.version,
      executable: asset.executable,
      harness: asset.harness,
    }),
  );
  if (active) {
    yield* fs.writeFileString(
      path.join(managedDirectory, "active.json"),
      encodeJsonString({ releaseId: asset.sha256 }),
    );
  }
});

interface HarnessOptions {
  readonly baseDir?: string;
  readonly asset?: AntigravityReleaseAsset | null;
  readonly archive?: Buffer;
  readonly body?: Stream.Stream<Uint8Array> | undefined;
  readonly contentLength?: number;
  readonly contentEncoding?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly path?: string;
  readonly previous?: boolean;
  readonly fileSystem?: FileSystem.FileSystem;
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly validate?: AntigravityInstallation.AntigravityInstallationOptions["validate"];
  readonly useDefaultValidation?: boolean;
  readonly useBundledRelease?: boolean;
  readonly connectTimeout?: boolean;
}

export const makeHarness = Effect.fn("test.makeAntigravityInstallation")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir =
    options.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "goat-agy-test-" }));
  const platform = options.platform ?? hostPlatform;
  const arch = options.arch ?? "x64";
  const archive = options.archive ?? completeArchive;
  const asset =
    options.asset === undefined ? yield* releaseAsset(archive, platform) : options.asset;
  const managedDirectory = path.join(baseDir, "tools", "antigravity-acp", `${platform}-${arch}`);
  if (options.previous) {
    yield* writeRelease(managedDirectory, {
      ...(yield* releaseAsset(archive, platform)),
      sha256: previousReleaseId,
      version: previousVersion,
    });
  }
  const stagingReleased = yield* Deferred.make<void>();
  const requests: string[] = [];
  const validations: Array<{
    executable: AntigravityInstallation.AntigravityExecutable;
    version: string;
  }> = [];
  const installationFs = options.fileSystem ?? fs;
  const trackedFs = FileSystem.FileSystem.of({
    ...installationFs,
    makeTempDirectoryScoped: (settings) =>
      settings?.prefix === ".install-"
        ? Effect.acquireRelease(installationFs.makeTempDirectory(settings), (directory) =>
            fs
              .remove(directory, { recursive: true, force: true })
              .pipe(Effect.orDie, Effect.andThen(Deferred.succeed(stagingReleased, undefined))),
          )
        : installationFs.makeTempDirectoryScoped(settings),
  });
  const installation = yield* AntigravityInstallation.makeAntigravityInstallation({
    baseDir,
    ...(options.useBundledRelease ? {} : { releaseAsset: asset }),
    ...(options.useDefaultValidation
      ? {}
      : {
          validate: (executable: AntigravityInstallation.AntigravityExecutable, version: string) =>
            Effect.sync(() => validations.push({ executable, version })).pipe(
              Effect.andThen(options.validate?.(executable, version) ?? Effect.void),
            ),
        }),
  }).pipe(
    options.spawner
      ? Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner)
      : (effect) => effect,
    Effect.provideService(FileSystem.FileSystem, trackedFs),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.Architecture, arch),
    Effect.provideService(HostProcess.Environment, { PATH: options.path ?? "" }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.suspend(() => {
          requests.push(request.url);
          if (options.connectTimeout)
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error("Connect Timeout Error"),
                }),
              }),
            );
          const response = HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              headers: {
                ...(options.contentLength === undefined
                  ? {}
                  : { "content-length": String(options.contentLength) }),
                ...(options.contentEncoding === undefined
                  ? {}
                  : { "content-encoding": options.contentEncoding }),
              },
            }),
          );
          return Effect.succeed(
            Object.defineProperty(response, "stream", {
              value:
                options.body ??
                Stream.make(
                  archive.subarray(0, 31),
                  archive.subarray(31, 149),
                  archive.subarray(149),
                ),
            }),
          );
        }),
      ),
    ),
  );
  return { installation, fs, path, baseDir, requests, validations, stagingReleased };
});

export const terminalState = (
  installation: AntigravityInstallation.AntigravityInstallation["Service"],
) =>
  installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
