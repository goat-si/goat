// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import type { ProviderInstallState } from "@goat/contracts";
import { cliArchiveTarCommand } from "@goat/shared/cliRelease";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";

import { openZipArchive } from "../zipArchive.ts";
import {
  ANTIGRAVITY_DOWNLOAD_HOSTS,
  refuseRedirects,
  type AntigravityCliReleaseAsset,
} from "./antigravityCliRelease.ts";
import {
  type AntigravityInstallationError,
  DOWNLOAD_TIMEOUT,
  installationError,
  MAX_DOWNLOAD_BYTES,
  MAX_EXECUTABLE_BYTES,
  wrapFailure,
} from "./AntigravityInstallationRecords.ts";
import type { AntigravityReleaseAsset } from "./antigravityRelease.ts";

/**
 * Streams a release to archivePath and checks its digest: SHA-512 from Google's CLI manifest, or
 * the pinned release's SHA-256 and exact size. Only Google hosts, and no redirects, are fetched.
 */
export const downloadVerifiedArchive = Effect.fn("AntigravityInstallation.download")(
  function* (input: {
    readonly http: HttpClient.HttpClient;
    readonly fs: FileSystem.FileSystem;
    readonly state: SubscriptionRef.SubscriptionRef<ProviderInstallState>;
    readonly asset: AntigravityReleaseAsset | AntigravityCliReleaseAsset;
    readonly archivePath: string;
  }) {
    const { http, fs, state, asset, archivePath } = input;
    const cli = "sha512" in asset;
    const archiveBytes = cli ? null : asset.archiveBytes;
    if (!ANTIGRAVITY_DOWNLOAD_HOSTS.has(URL.parse(asset.url)?.host ?? "")) {
      return yield* installationError(
        "download",
        "The Antigravity download is not hosted by Google.",
      );
    }
    const hash = NodeCrypto.createHash(cli ? "sha512" : "sha256");
    let downloadedBytes = 0;
    let lastProgressAt = yield* Clock.currentTimeMillis;
    yield* Effect.gen(function* () {
      const response = yield* http
        .execute(HttpClientRequest.get(asset.url))
        .pipe(refuseRedirects, Effect.flatMap(HttpClientResponse.filterStatusOk));
      // dl.google.com may gzip the zip: content-length is encoded, while byte/hash checks use decoded data.
      const contentLength = response.headers["content-length"];
      const contentEncoding = response.headers["content-encoding"]?.trim().toLowerCase();
      const identityBody = contentEncoding === undefined || contentEncoding === "identity";
      if (
        identityBody &&
        contentLength !== undefined &&
        archiveBytes !== null &&
        Number(contentLength) !== archiveBytes
      ) {
        return yield* installationError(
          "download",
          "The Antigravity download size did not match the pinned release.",
        );
      }
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            downloadedBytes += chunk.byteLength;
            if (downloadedBytes > (archiveBytes ?? MAX_DOWNLOAD_BYTES)) {
              return yield* installationError(
                "download",
                "The Antigravity download exceeded its allowed size.",
              );
            }
            hash.update(chunk);
            const now = yield* Clock.currentTimeMillis;
            if (now - lastProgressAt >= 250 || downloadedBytes === archiveBytes) {
              lastProgressAt = now;
              yield* SubscriptionRef.update(state, (current) => ({
                ...current,
                downloadedBytes,
              }));
            }
          }),
        ),
        Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
      );
    }).pipe(
      Effect.timeout(DOWNLOAD_TIMEOUT),
      Effect.mapError((cause) =>
        HttpClientError.isHttpClientError(cause) || Cause.isTimeoutError(cause)
          ? installationError(
              "download",
              "Could not download Antigravity from Google. Check the network connection and any proxy settings, then try again.",
              cause,
            )
          : cause,
      ),
    );
    if (
      (archiveBytes !== null && downloadedBytes !== archiveBytes) ||
      hash.digest("hex") !== (cli ? asset.sha512 : asset.sha256)
    ) {
      return yield* installationError(
        "download",
        "The Antigravity download failed its size or checksum check. Nothing was installed.",
      );
    }
  },
);

/** Extracts the verified archive: the native CLI's single executable, or the pinned pair. */
export const extractRuntime = Effect.fn("AntigravityInstallation.extract")(function* (input: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly asset: AntigravityReleaseAsset | AntigravityCliReleaseAsset;
  readonly archivePath: string;
  readonly pairDirectory: string;
  /** The streamed extraction's cap; tests lower it to reach the refusal. */
  readonly maxExecutableBytes?: number;
}) {
  const { fs, path, spawner, platform, environment, asset, archivePath, pairDirectory } = input;
  const maxExecutableBytes = input.maxExecutableBytes ?? MAX_EXECUTABLE_BYTES;
  const cli = "sha512" in asset;
  if (cli) {
    const executablePath = path.join(pairDirectory, asset.executable.name);
    if (asset.format === "executable") {
      yield* fs.copyFile(archivePath, executablePath);
    } else {
      const tar = cliArchiveTarCommand(platform, environment);
      const list = yield* spawner.string(ChildProcess.make(tar, ["-tzf", archivePath]));
      const types = yield* spawner.string(ChildProcess.make(tar, ["-tvzf", archivePath]));
      if (
        list.trim() !== asset.executable.name ||
        types.trim().split(/\r?\n/u).length !== 1 ||
        !types.startsWith("-")
      ) {
        return yield* installationError(
          "extract",
          "The Antigravity archive must contain one regular executable.",
        );
      }
      yield* Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(tar, ["-xOzf", archivePath, asset.executable.name], {
            stdout: "pipe",
            stderr: "pipe",
          }),
        );
        let extractedBytes = 0;
        yield* child.stdout.pipe(
          Stream.tap((chunk) =>
            Effect.gen(function* () {
              extractedBytes += chunk.byteLength;
              if (extractedBytes > maxExecutableBytes)
                return yield* installationError(
                  "extract",
                  "The Antigravity executable exceeded its size limit.",
                );
            }),
          ),
          Stream.run(fs.sink(executablePath, { flag: "wx", mode: 0o700 })),
        );
        if ((yield* child.exitCode) !== 0 || extractedBytes === 0)
          return yield* installationError(
            "extract",
            "Could not extract the Antigravity executable.",
          );
      }).pipe(Effect.scoped);
    }
  } else
    yield* Effect.gen(function* () {
      const archive = yield* openZipArchive(archivePath, (detail, cause) =>
        installationError("extract", detail, cause),
      );
      if (archive.entryCount !== 2) {
        return yield* installationError(
          "extract",
          "The archive must contain exactly the Antigravity executable and its harness.",
        );
      }
      const seen = new Set<string>();
      for (;;) {
        const entry = yield* archive.next;
        if (!entry) break;
        const expected = [asset.executable, asset.harness].find(
          (file) => file.name === entry.fileName,
        );
        const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (
          !expected ||
          seen.has(entry.fileName) ||
          entry.fileName.includes("/") ||
          entry.fileName.includes("\\") ||
          (unixType !== 0 && unixType !== 0o100000) ||
          (entry.externalFileAttributes & 0x10) !== 0 ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          ![0, 8].includes(entry.compressionMethod) ||
          entry.uncompressedSize !== expected.bytes
        ) {
          return yield* installationError(
            "extract",
            "The archive contains an unexpected, unsafe, or incorrectly sized member.",
          );
        }
        seen.add(entry.fileName);
        yield* Effect.gen(function* () {
          const readable = yield* archive.streamEntry(entry);
          let extractedBytes = 0;
          yield* EffectNodeStream.fromReadable<Uint8Array, AntigravityInstallationError>({
            evaluate: () => readable,
            onError: wrapFailure("extract", "Could not extract the Antigravity runtime."),
          }).pipe(
            Stream.tap((chunk) =>
              Effect.gen(function* () {
                extractedBytes += chunk.byteLength;
                if (extractedBytes > expected.bytes) {
                  return yield* installationError(
                    "extract",
                    "An archive member exceeded its pinned size.",
                  );
                }
              }),
            ),
            Stream.run(
              fs.sink(path.join(pairDirectory, entry.fileName), { flag: "wx", mode: 0o700 }),
            ),
          );
          if (extractedBytes !== expected.bytes) {
            return yield* installationError("extract", "An archive member was truncated.");
          }
        }).pipe(Effect.scoped);
      }
      if (!seen.has(asset.executable.name) || !seen.has(asset.harness.name)) {
        return yield* installationError(
          "extract",
          "The archive is missing the Antigravity executable or its harness.",
        );
      }
    }).pipe(Effect.scoped);
});
