// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@goat/shared/HostProcess";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { runInstaller } from "./ProviderHostSyncInstall.ts";
import type { PinnedArtifact } from "./ProviderHostSyncRecipes.ts";

const DOWNLOAD_DEADLINE = Duration.minutes(10);

/** A verified install that stopped; its message is safe to show. */
class ArtifactInstallError extends Data.TaggedError("ArtifactInstallError")<{
  readonly message: string;
}> {}

const stop = (message: string) => new ArtifactInstallError({ message });

const archOf = (arch: string) => (arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null);

/**
 * Downloads a pinned release into a private staging folder, and unpacks it only when its size and
 * SHA-256 match the pin. Anything else fails closed: nothing is unpacked, linked or run.
 */
export const installArtifact = Effect.fn("ProviderHostSync.installArtifact")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  name: string,
  artifact: PinnedArtifact,
) {
  const platform = yield* HostProcess.Platform;
  const runtimeArch = yield* HostProcess.Architecture;
  const arch = archOf(runtimeArch);
  const os = platform === "darwin" || platform === "linux" ? platform : null;
  const asset = os === null || arch === null ? undefined : artifact.assets[`${os}-${arch}`];
  if (os === null || arch === null || asset === undefined)
    return yield* stop(`GOAT has no verified ${name} build for ${platform} ${runtimeArch}.`);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const home = yield* HostProcess.HomeDirectory;
  const versions = path.join(home, ...artifact.root.split("/"));
  const io = (message: string) => Effect.mapError(() => stop(message));

  yield* fs
    .makeDirectory(versions, { recursive: true })
    .pipe(io(`GOAT could not create ${versions} for ${name}.`));
  const staging = yield* fs
    .makeTempDirectoryScoped({ directory: versions, prefix: ".goat-install-" })
    .pipe(io(`GOAT could not create a staging folder for ${name}.`));
  const archive = path.join(staging, "package.tar.gz");
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  const url = artifact.url.replace("{os}", os).replace("{arch}", arch);
  const fetched = yield* http.execute(HttpClientRequest.get(url)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) =>
      response.stream.pipe(
        Stream.tap((chunk) => {
          bytes += chunk.byteLength;
          // A larger body cannot match the pin; stop reading instead of filling the disk.
          if (bytes > asset.bytes) return Effect.fail("oversize" as const);
          hash.update(chunk);
          return Effect.void;
        }),
        Stream.run(fs.sink(archive, { flag: "wx", mode: 0o600 })),
      ),
    ),
    Effect.timeoutOption(DOWNLOAD_DEADLINE),
    Effect.map(Option.isSome),
    Effect.orElseSucceed(() => false),
  );
  // An oversized body stops the download too; that is a mismatch, reported as one below.
  if (!fetched && bytes <= asset.bytes)
    return yield* stop(
      `GOAT could not download ${name} ${artifact.version} from ${new URL(url).hostname}. Nothing was installed.`,
    );
  if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256)
    return yield* stop(
      `The ${name} download did not match GOAT's pinned SHA-256 for ${artifact.version}. Nothing was installed.`,
    );

  const unpacked = path.join(staging, "package");
  yield* fs.makeDirectory(unpacked).pipe(io(`GOAT could not unpack ${name}.`));
  const tar = yield* runInstaller(spawner, "tar", [
    "--strip-components=1",
    "-xzf",
    archive,
    "-C",
    unpacked,
  ]);
  if (tar.exitCode !== 0) return yield* stop(`GOAT could not unpack the verified ${name} release.`);
  const final = path.join(versions, artifact.version);
  const bin = path.join(home, ".local", "bin");
  // Replace only links this install owns; any other file under that name is someone else's.
  for (const link of artifact.links) {
    const at = path.join(bin, link);
    const target = yield* fs.readLink(at).pipe(Effect.option);
    const ours = Option.isSome(target) && target.value.startsWith(versions + path.sep);
    if (
      !ours &&
      (Option.isSome(target) || (yield* fs.exists(at).pipe(Effect.orElseSucceed(() => true))))
    )
      return yield* stop(
        `${at} already exists and is not ${name}'s. GOAT left it alone and installed nothing.`,
      );
  }
  yield* Effect.gen(function* () {
    yield* fs.remove(final, { recursive: true, force: true });
    yield* fs.rename(unpacked, final);
    yield* fs.makeDirectory(bin, { recursive: true });
    for (const link of artifact.links) {
      const at = path.join(bin, link);
      yield* fs.remove(at, { force: true });
      yield* fs.symlink(path.join(final, artifact.entry), at);
    }
  }).pipe(io(`GOAT verified ${name}, but could not place it in ${bin}.`));
}, Effect.scoped);
