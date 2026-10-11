import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
  cliReleaseDownloadBaseUrl,
  parseChecksums,
  type CliArchivePlatformKey,
} from "@t3tools/shared/cliRelease";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { SshLaunchError } from "./errors.ts";
import { MAX_RUNTIME_ARCHIVE_BYTES, readLocalRuntimeArchive } from "./runtimeArchive.ts";

export class RuntimeArchiveNotPublished extends Schema.TaggedError<RuntimeArchiveNotPublished>()(
  "RuntimeArchiveNotPublished",
  { version: Schema.String, asset: Schema.String },
) {}

export class RuntimeArchiveNetworkError extends Schema.TaggedError<RuntimeArchiveNetworkError>()(
  "RuntimeArchiveNetworkError",
  { version: Schema.String, asset: Schema.String, cause: Schema.Defect() },
) {}

const isRuntimeArchiveNotPublished = Schema.is(RuntimeArchiveNotPublished);
const cacheLocks = Effect.runSync(KeyedLock.make<string>());

/** Acquire public release bytes locally and publish only a verified cache transaction. */
export const downloadRuntimeArchiveWithHttps = Effect.fn("ssh.runtimeArchive.https")(function* (
  archiveDirectory: string,
  version: string,
  platformKey: CliArchivePlatformKey,
  fetchImpl: typeof fetch = fetch,
) {
  const path = yield* Path.Path;
  const directory = path.resolve(archiveDirectory);
  const asset = cliArchiveFileName(version, platformKey);
  const download = (name: string) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchImpl(`${cliReleaseDownloadBaseUrl(version)}/${name}`, {
          signal,
        });
        if (response.status === 404) throw new RuntimeArchiveNotPublished({ version, asset: name });
        if (!response.ok) throw new Error(`HTTPS release returned status ${response.status}`);
        const tooLarge = () =>
          new SshLaunchError({
            message: "Public HTTPS SSH runtime download must be no larger than 256 MiB.",
            stdout: "",
          });
        const length = response.headers.get("content-length");
        if (length !== null && Number(length) > MAX_RUNTIME_ARCHIVE_BYTES) {
          await response.body?.cancel();
          throw tooLarge();
        }
        if (response.body === null) return new Uint8Array();
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_RUNTIME_ARCHIVE_BYTES) {
              await reader.cancel();
              throw tooLarge();
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      },
      catch: (cause) =>
        cause instanceof SshLaunchError
          ? cause
          : isRuntimeArchiveNotPublished(cause)
            ? cause
            : new RuntimeArchiveNetworkError({ version, asset: name, cause }),
    });
  return yield* cacheLocks
    .withLock(
      path.join(directory, asset),
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cached = yield* readLocalRuntimeArchive(directory, version, platformKey);
        if (cached !== null) return cached;
        yield* fs.makeDirectory(directory, { recursive: true });
        const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".goat-https-" });
        yield* fs.chmod(staging, 0o700);
        const checksums = parseChecksums(
          new TextDecoder().decode(yield* download(CLI_RELEASE_CHECKSUMS_FILE)),
        );
        const expected = checksums.get(asset);
        if (expected === undefined)
          return yield* new SshLaunchError({
            message: `Public HTTPS SHA256SUMS has no valid checksum for ${asset}.`,
            stdout: "",
          });
        const bytes = yield* download(asset);
        yield* fs.writeFile(path.join(staging, asset), bytes);
        const archive = yield* readLocalRuntimeArchive(staging, version, platformKey);
        if (archive === null || archive.sha256 !== expected)
          return yield* new SshLaunchError({
            message: `Public HTTPS SSH runtime archive SHA-256 mismatch (${asset}).`,
            stdout: "",
          });
        const sidecar = `${asset}.sha256`;
        yield* fs.writeFileString(path.join(staging, sidecar), `${expected}  ${asset}\n`);
        yield* fs.rename(path.join(staging, sidecar), path.join(directory, sidecar));
        yield* fs.rename(path.join(staging, asset), path.join(directory, asset));
        return archive;
      }).pipe(Effect.scoped),
    )
    .pipe(
      Effect.timeoutOrElse({
        duration: "5 minutes",
        orElse: () =>
          Effect.fail(
            new RuntimeArchiveNetworkError({
              version,
              asset,
              cause: new Error("Public HTTPS release download timed out"),
            }),
          ),
      }),
    );
});
