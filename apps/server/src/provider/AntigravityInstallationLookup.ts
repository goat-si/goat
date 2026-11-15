import { resolveCommandPath } from "@goat/shared/shell";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { DRIVER, installationError, RECORD_MAX_BYTES } from "./AntigravityInstallationRecords.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";

/** A release the model manifest marks broken or unsupported is never installed or launched. */
export function makeWithdrawalCheck(manifestService: ModelManifest.ModelManifest["Service"]) {
  const isWithdrawn = Effect.fn("AntigravityInstallation.isWithdrawn")(function* (version: string) {
    const manifest = yield* manifestService.current;
    const status = (
      resolveProviderCompatibility(manifest.compatibility, DRIVER, version) ??
      resolveProviderCompatibility(
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
        DRIVER,
        version,
      )
    )?.status;
    return status === "broken" || status === "unsupported";
  });
  const ensureEligible = Effect.fn("AntigravityInstallation.ensureEligible")(function* (
    version: string,
  ) {
    if (yield* isWithdrawn(version))
      return yield* installationError(
        "verify",
        "This Antigravity release was withdrawn. Check for updates and try again.",
      );
  });
  return { isWithdrawn, ensureEligible };
}

export function makeRecordReaders(deps: {
  readonly fs: FileSystem.FileSystem;
  readonly platform: NodeJS.Platform;
}) {
  const { fs, platform } = deps;
  const readRecord = Effect.fn("AntigravityInstallation.readRecord")(function* <A>(
    filePath: string,
    schema: Schema.Codec<A>,
  ) {
    const info = yield* fs.stat(filePath);
    if (info.type !== "File" || Number(info.size) > RECORD_MAX_BYTES) {
      return yield* installationError(
        "resolve",
        "The managed runtime record is invalid. Reinstall Antigravity.",
      );
    }
    const contents = yield* fs.readFileString(filePath);
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(contents);
  });

  const executableFile = Effect.fn("AntigravityInstallation.executableFile")(function* (
    filePath: string,
    bytes?: number,
  ) {
    const info = yield* fs.stat(filePath).pipe(Effect.option);
    return (
      Option.isSome(info) &&
      info.value.type === "File" &&
      (bytes === undefined || Number(info.value.size) === bytes) &&
      (platform === "win32" || (info.value.mode & 0o111) !== 0)
    );
  });
  return { readRecord, executableFile };
}

export function makeCommandCandidates(deps: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const { fs, path, platform, environment } = deps;
  const commandPath = (command: string, env: NodeJS.ProcessEnv) =>
    resolveCommandPath(command, { env }).pipe(
      Effect.map((resolved) => (resolved === null ? null : path.resolve(resolved))),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  // Resolve per PATH entry so an executable without its harness falls through to later entries.
  const commandCandidates = Effect.fn("AntigravityInstallation.commandCandidates")(function* (
    command: string,
    processEnvironment = environment,
  ) {
    if (command.includes("/") || command.includes("\\")) {
      const resolved = yield* commandPath(command, processEnvironment);
      return resolved === null ? [] : [resolved];
    }
    const pathValue =
      platform === "win32"
        ? Object.entries(processEnvironment).findLast(([key]) => key.toUpperCase() === "PATH")?.[1]
        : processEnvironment.PATH;
    const candidates: string[] = [];
    for (const directory of (pathValue ?? "").split(platform === "win32" ? ";" : ":")) {
      const entry = directory.trim().replace(/^"|"$/gu, "");
      if (entry.length === 0) continue;
      const resolved = yield* commandPath(command, { ...processEnvironment, PATH: entry });
      if (resolved !== null) candidates.push(resolved);
    }
    return candidates;
  });
  return commandCandidates;
}
