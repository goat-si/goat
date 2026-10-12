import {
  CLI_RELEASE_CHECKSUMS_FILE,
  CLI_RELEASE_REPOSITORY,
  cliArchiveFileName,
  parseChecksums,
  type CliArchivePlatformKey,
} from "@goat/shared/cliRelease";
import * as KeyedLock from "@goat/shared/KeyedLock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { SshLaunchError } from "./errors.ts";
import { readLocalRuntimeArchive } from "./runtimeArchive.ts";

const GH_DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_GH_OUTPUT_LENGTH = 4_000;
const MAX_GH_ERROR_LENGTH = 400;
// One local process coalesces concurrent prepares for the same archive.
const cacheLocks = Effect.runSync(KeyedLock.make<string>());
const sanitizeGhStderr = (value: string) =>
  value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/(?:github_pat_|gh[opusr]_)[A-Za-z0-9_]+/gu, "[redacted]")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-MAX_GH_ERROR_LENGTH);
const collectGhOutput = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (output, chunk) => (output + chunk).slice(-MAX_GH_OUTPUT_LENGTH),
    ),
  );

/** Download locally; only verified archive bytes may reach SSH. */
export const downloadRuntimeArchiveWithGh = Effect.fn("ssh.runtimeArchive.gh")(function* (
  archiveDirectory: string,
  version: string,
  platformKey: CliArchivePlatformKey,
  ghCommand = "gh",
) {
  const path = yield* Path.Path;
  const directory = path.resolve(archiveDirectory);
  const tag = `v${version}`;
  const asset = cliArchiveFileName(version, platformKey);
  const context = `repo=${CLI_RELEASE_REPOSITORY}, tag=${tag}, asset=${asset}, archive directory=${directory}`;
  return yield* cacheLocks
    .withLock(
      path.join(directory, asset),
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // A racing prepare may have populated the cache while this one waited.
        const cached = yield* readLocalRuntimeArchive(directory, version, platformKey);
        if (cached !== null) return cached;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* fs.makeDirectory(directory, { recursive: true });
        // Stage both files on the cache filesystem; publish complete files by rename.
        const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".goat-gh-" });
        yield* fs.chmod(staging, 0o700);
        const child = yield* spawner
          .spawn(
            ChildProcess.make(
              ghCommand,
              [
                "release",
                "download",
                tag,
                "--repo",
                CLI_RELEASE_REPOSITORY,
                "--pattern",
                asset,
                "--pattern",
                CLI_RELEASE_CHECKSUMS_FILE,
                "--dir",
                staging,
              ],
              {
                env: { GH_PROMPT_DISABLED: "1" },
                extendEnv: true,
                stdin: "ignore",
                shell: false,
              },
            ),
          )
          .pipe(
            Effect.mapError((cause) =>
              cause instanceof PlatformError.PlatformError && cause.reason._tag === "NotFound"
                ? new SshLaunchError({
                    message: `gh not found on PATH (command=${ghCommand}; ${context}). Install gh or supply runner.ghCommand with an executable path.`,
                    stdout: "",
                    cause,
                  })
                : cause,
            ),
          );
        const [, stderr, exitCode] = yield* Effect.all(
          [
            Stream.runDrain(child.stdout),
            collectGhOutput(child.stderr),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          const diagnostic = sanitizeGhStderr(stderr);
          return yield* new SshLaunchError({
            message: `Local gh release download failed (exit ${exitCode}; ${context}). Check gh auth status and that the release contains both assets.${diagnostic === "" ? "" : ` stderr (last ${MAX_GH_ERROR_LENGTH} sanitized characters): ${diagnostic}`}`,
            stdout: "",
            cause: { exitCode, stderr: diagnostic },
          });
        }
        const checksums = parseChecksums(
          yield* fs.readFileString(path.join(staging, CLI_RELEASE_CHECKSUMS_FILE)),
        );
        const expected = checksums.get(asset);
        if (expected === undefined) {
          return yield* new SshLaunchError({
            message: `SHA256SUMS has no valid checksum for the SSH runtime archive (${context}).`,
            stdout: "",
          });
        }
        const archive = yield* readLocalRuntimeArchive(staging, version, platformKey);
        if (archive === null) {
          return yield* new SshLaunchError({
            message: `gh did not download the SSH runtime archive (${context}).`,
            stdout: "",
          });
        }
        if (archive.sha256 !== expected) {
          return yield* new SshLaunchError({
            message: `SSH runtime archive SHA-256 mismatch (${context}).`,
            stdout: "",
          });
        }
        const sidecar = `${asset}.sha256`;
        yield* fs.writeFileString(path.join(staging, sidecar), `${expected}  ${asset}\n`);
        // Sidecar first: interruption can leave a sidecar alone, never a gh
        // archive that a later cache hit would mistake for a trusted local build.
        yield* fs.rename(path.join(staging, sidecar), path.join(directory, sidecar));
        yield* fs.rename(path.join(staging, asset), path.join(directory, asset));
        return archive;
      }).pipe(Effect.scoped),
    )
    .pipe(
      Effect.mapError((cause) =>
        cause instanceof SshLaunchError && cause.message.includes(context)
          ? cause
          : new SshLaunchError({
              message: `Failed to acquire the SSH runtime archive with local gh (${context}). Ensure gh is installed and authenticated, both release assets exist, and the archive directory is writable.`,
              stdout: "",
              cause,
            }),
      ),
      Effect.timeoutOption(Duration.millis(GH_DOWNLOAD_TIMEOUT_MS)),
      Effect.flatMap((result) =>
        Option.match(result, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              new SshLaunchError({
                message: `Local gh SSH runtime download timed out (${context}).`,
                stdout: "",
              }),
            ),
        }),
      ),
    );
});
