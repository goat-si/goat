import {
  cliArchiveFileName,
  parseChecksums,
  type CliArchivePlatformKey,
} from "@t3tools/shared/cliRelease";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { SshLaunchError } from "./errors.ts";

export const MAX_RUNTIME_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_LOCAL_ARCHIVE_BYTES = BigInt(MAX_RUNTIME_ARCHIVE_BYTES);

export const readLocalRuntimeArchive = Effect.fn("ssh.runtimeArchive.read")(function* (
  directory: string,
  version: string,
  platformKey: CliArchivePlatformKey,
  requireSidecar = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const fileName = cliArchiveFileName(version, platformKey);
  const filePath = path.join(directory, fileName);
  if (!(yield* fs.exists(filePath))) return null;
  const stat = yield* fs.stat(filePath);
  if (stat.type !== "File" || stat.size > MAX_LOCAL_ARCHIVE_BYTES) {
    return yield* new SshLaunchError({
      message: "Local SSH runtime archive must be a file no larger than 256 MiB.",
      stdout: "",
    });
  }
  const bytes = yield* fs.readFile(filePath);
  // A file can change between stat and read; hash only the size we validated.
  if (
    BigInt(bytes.byteLength) > MAX_LOCAL_ARCHIVE_BYTES ||
    BigInt(bytes.byteLength) !== stat.size
  ) {
    return yield* new SshLaunchError({
      message: "Local SSH runtime archive size changed while reading.",
      stdout: "",
    });
  }
  const sha256 = Hex.encode(yield* crypto.digest("SHA-256", bytes));
  const sidecarPath = `${filePath}.sha256`;
  const hasSidecar = yield* fs.exists(sidecarPath);
  if (requireSidecar && !hasSidecar) {
    return yield* new SshLaunchError({
      message: `Bundled SSH runtime archive is missing its SHA-256 sidecar (${sidecarPath}). Rebuild or reinstall the desktop bundle.`,
      stdout: "",
    });
  }
  if (hasSidecar) {
    const sidecar = yield* fs.readFileString(sidecarPath);
    const expected = parseChecksums(sidecar).get(fileName);
    if (requireSidecar && sidecar !== `${sha256}  ${fileName}\n`) {
      return yield* new SshLaunchError({
        message: `Bundled SSH runtime archive requires a canonical matching SHA-256 sidecar (${sidecarPath}). Rebuild or reinstall the desktop bundle.`,
        stdout: "",
      });
    }
    if (expected === undefined || sha256 !== expected) {
      return yield* new SshLaunchError({
        message: `Cached SSH runtime archive SHA-256 mismatch or malformed sidecar (${filePath}). Remove or replace the invalid cache entry before retrying.`,
        stdout: "",
      });
    }
  }
  // An archive without a sidecar remains a trusted user-supplied local build.
  return { fileName, bytes, sha256 };
});
