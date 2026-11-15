// @effect-diagnostics nodeBuiltinImport:off - Effect has no free-space query.
import { type ProviderInstallState } from "@goat/contracts";
import { expandHomePath } from "@goat/provider-core/server/pathExpansion";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveNodeExecutable, nodeRuntimeUnavailableMessage } from "@goat/shared/nodeRuntime";
import { compareSemverVersions } from "@goat/shared/semver";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeFSP from "node:fs/promises";

import * as ServerConfig from "../config.ts";
import {
  antigravityCliTarget,
  lookupAntigravityCliRelease,
  type AntigravityCliReleaseAsset,
} from "./antigravityCliRelease.ts";
import { downloadVerifiedArchive, extractRuntime } from "./AntigravityInstallationArchive.ts";
import {
  ActiveRelease,
  type AntigravityExecutable,
  AntigravityInstallationError,
  DRIVER,
  encodeActiveRelease,
  encodeInstalledRelease,
  executableNames,
  FREE_SPACE_MARGIN,
  InstalledRelease,
  installationError,
  isAntigravityCli,
  isRunning,
  LARGE_PAGE_KERNEL_MESSAGE,
  MAX_DOWNLOAD_BYTES,
  MAX_EXECUTABLE_BYTES,
  RELEASE_RECORD,
  UPDATE_CHECK_INTERVAL,
  VALIDATION_TIMEOUT,
  wrapFailure,
} from "./AntigravityInstallationRecords.ts";
import {
  makeCommandCandidates,
  makeRecordReaders,
  makeWithdrawalCheck,
} from "./AntigravityInstallationLookup.ts";
import { makeAntigravityValidator } from "./AntigravityInstallationValidate.ts";
import * as ModelManifest from "./ModelManifest.ts";
import {
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravityRelease.ts";

export { AntigravityInstallationError, type AntigravityExecutable };

interface AntigravityInstallationService {
  readonly managedDirectory: string;
  readonly resolve: (
    binaryPath?: string,
    environment?: NodeJS.ProcessEnv,
  ) => Effect.Effect<AntigravityExecutable, AntigravityInstallationError>;
  /** Hold the lease until the spawned process has exited. */
  readonly acquire: (
    binaryPath?: string,
    environment?: NodeJS.ProcessEnv,
  ) => Effect.Effect<AntigravityExecutable, AntigravityInstallationError, Scope.Scope>;
  readonly start: Effect.Effect<ProviderInstallState, AntigravityInstallationError>;
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ProviderInstallState, AntigravityInstallationError>;
  readonly state: Effect.Effect<ProviderInstallState>;
  readonly changes: Stream.Stream<ProviderInstallState>;
  /** Looks up Google's CLI manifest at most hourly; the caller gates it on update checks. */
  readonly checkForUpdate: Effect.Effect<void>;
  readonly remove: (
    protectedBinaryPaths?: ReadonlyArray<string>,
  ) => Effect.Effect<void, AntigravityInstallationError>;
}

export class AntigravityInstallation extends Context.Service<
  AntigravityInstallation,
  AntigravityInstallationService
>()("goat/provider/AntigravityInstallation") {
  static readonly layer = Layer.effect(
    AntigravityInstallation,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return yield* makeAntigravityInstallation({ baseDir: config.baseDir });
    }),
  );
}

export interface AntigravityInstallationOptions {
  readonly baseDir: string;
  readonly releaseAsset?: AntigravityReleaseAsset | AntigravityCliReleaseAsset | null;
  readonly validate?: (
    executable: AntigravityExecutable,
    expectedVersion: string,
  ) => Effect.Effect<void, AntigravityInstallationError, Scope.Scope>;
}

export const makeAntigravityInstallation = Effect.fn("AntigravityInstallation.make")(function* (
  options: AntigravityInstallationOptions,
) {
  const manifestService = yield* ModelManifest.ModelManifest;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  // The pinned release stays the fallback whenever Google's CLI manifest offers nothing usable.
  const pinned =
    options.releaseAsset === undefined
      ? resolveAntigravityReleaseAsset(platform, arch)
      : options.releaseAsset;
  let releaseAsset: AntigravityReleaseAsset | AntigravityCliReleaseAsset | null = pinned;
  const supported =
    options.releaseAsset === undefined
      ? antigravityCliTarget(platform, arch) !== null || pinned !== null
      : options.releaseAsset !== null;
  const names = executableNames(platform);
  const managedDirectory = path.join(
    options.baseDir,
    "tools",
    "antigravity-acp",
    `${platform}-${arch}`,
  );
  const versionsDirectory = path.join(managedDirectory, "versions");
  const activePath = path.join(managedDirectory, "active.json");
  const gate = yield* Semaphore.make(1);
  const leases = new Map<string, number>();
  let running: { readonly operationId: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: DRIVER,
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes:
      releaseAsset !== null && "archiveBytes" in releaseAsset ? releaseAsset.archiveBytes : null,
    version: releaseAsset?.version ?? null,
    installedVersion: null,
    canRemove: false,
    message: null,
  });

  const { isWithdrawn, ensureEligible } = makeWithdrawalCheck(manifestService);
  const { readRecord, executableFile } = makeRecordReaders({ fs, platform });
  const commandCandidates = makeCommandCandidates({ fs, path, platform, environment });

  const completedRelease = Effect.fn("AntigravityInstallation.completedRelease")(function* (
    releaseId: string,
  ) {
    const directory = path.join(versionsDirectory, releaseId);
    const record = yield* readRecord(path.join(directory, RELEASE_RECORD), InstalledRelease);
    if (
      record.releaseId !== releaseId ||
      (record.harness === null
        ? record.executable.name !== (platform === "win32" ? "agy.exe" : "antigravity")
        : record.executable.name !== names.executable || record.harness.name !== names.harness) ||
      !Number.isSafeInteger(record.executable.bytes) ||
      record.executable.bytes <= 0 ||
      (record.harness !== null &&
        (!Number.isSafeInteger(record.harness.bytes) || record.harness.bytes <= 0)) ||
      !record.version.trim() ||
      !(yield* executableFile(
        path.join(directory, record.executable.name),
        record.executable.bytes,
      )) ||
      (record.harness !== null &&
        !(yield* executableFile(path.join(directory, record.harness.name), record.harness.bytes)))
    ) {
      return yield* installationError(
        "resolve",
        "The managed Antigravity runtime is incomplete. Reinstall it.",
      );
    }
    return {
      executablePath: path.join(directory, record.executable.name),
      harnessPath: record.harness === null ? null : path.join(directory, record.harness.name),
      source: "managed",
      version: record.version,
      managedVersionDirectory: directory,
    } satisfies AntigravityExecutable;
  });

  const fromExternal = Effect.fn("AntigravityInstallation.fromExternal")(function* (
    candidate: string,
    source: "override" | "path",
  ) {
    if (!(yield* executableFile(candidate))) return null;
    const executablePath = yield* fs.realPath(candidate);
    const realVersions = yield* fs.realPath(versionsDirectory).pipe(Effect.option);
    const directory = path.dirname(executablePath);
    if (
      Option.isSome(realVersions) &&
      path.dirname(directory) === realVersions.value &&
      /^[a-f0-9]{64}$/u.test(path.basename(directory))
    ) {
      const installed = yield* completedRelease(path.basename(directory));
      return { ...installed, source };
    }
    // Keep launcher symlinks intact: version-manager shims dispatch by their invoked name.
    if (isAntigravityCli(candidate, executablePath)) {
      return {
        executablePath: candidate,
        harnessPath: null,
        source,
        version: null,
        managedVersionDirectory: null,
      } satisfies AntigravityExecutable;
    }
    const harnessPath = path.join(directory, names.harness);
    if (!(yield* executableFile(harnessPath))) return null;
    return {
      executablePath,
      harnessPath,
      source,
      version: null,
      managedVersionDirectory: null,
    } satisfies AntigravityExecutable;
  });

  const resolve: AntigravityInstallationService["resolve"] = Effect.fn(
    "AntigravityInstallation.resolve",
  )(
    function* (binaryPath?: string, processEnvironment?: NodeJS.ProcessEnv) {
      const override = expandHomePath(binaryPath?.trim() ?? "", yield* HostProcess.HomeDirectory);
      if (override) {
        for (const candidate of yield* commandCandidates(override, processEnvironment)) {
          const selected = yield* fromExternal(candidate, "override");
          if (selected) return selected;
        }
        return yield* installationError(
          "resolve",
          "The custom Antigravity executable is missing or not executable, or it needs a localharness_external sibling. The agy CLI does not.",
        );
      }
      if (yield* fs.exists(activePath)) {
        const active = yield* readRecord(activePath, ActiveRelease);
        const installed = yield* completedRelease(active.releaseId);
        if (yield* isWithdrawn(installed.version))
          return yield* installationError(
            "resolve",
            `Antigravity ${installed.version} no longer works with this GOAT release. Update it in Antigravity setup.`,
          );
        return installed;
      }
      for (const candidate of yield* commandCandidates(names.executable, processEnvironment)) {
        const selected = yield* fromExternal(candidate, "path");
        if (selected) return selected;
      }
      return yield* installationError(
        "resolve",
        supported
          ? "Antigravity ACP runtime is not installed. Install it in this environment's provider settings or set a custom ACP executable path. The Antigravity app, IDE, and CLI are separate installations."
          : `Google does not publish an Antigravity runtime for ${platform}-${arch}. Use a supported environment or a custom executable.`,
      );
    },
    Effect.mapError(
      wrapFailure(
        "resolve",
        "Could not read the Antigravity installation. Reinstall it or set a custom executable path.",
      ),
    ),
  );

  const acquire = (binaryPath?: string, processEnvironment?: NodeJS.ProcessEnv) =>
    Effect.acquireRelease(
      gate.withPermit(
        Effect.gen(function* () {
          const executable = yield* resolve(binaryPath, processEnvironment);
          const directory = executable.managedVersionDirectory;
          if (directory) leases.set(directory, (leases.get(directory) ?? 0) + 1);
          return executable;
        }),
      ),
      (executable) =>
        gate.withPermit(
          Effect.sync(() => {
            const directory = executable.managedVersionDirectory;
            if (!directory) return;
            const remaining = (leases.get(directory) ?? 1) - 1;
            if (remaining > 0) leases.set(directory, remaining);
            else leases.delete(directory);
          }),
        ),
    );
  const validate =
    options.validate ??
    makeAntigravityValidator({ fs, path, crypto, spawner, platform, environment });

  const install = Effect.fn("AntigravityInstallation.install")(
    function* (asset: AntigravityReleaseAsset | AntigravityCliReleaseAsset) {
      yield* ensureEligible(asset.version);
      const cli = "sha512" in asset;
      // Existing installation records use 64-character IDs, including native SHA-512 prefixes.
      const releaseId = cli ? asset.sha512.slice(0, 64) : asset.sha256;
      yield* resolveNodeExecutable("Antigravity", environment).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.mapError((cause) =>
          installationError("verify", nodeRuntimeUnavailableMessage("Antigravity"), cause),
        ),
      );
      if (!cli && platform === "linux" && arch === "arm64") {
        const pageSize = yield* spawner
          .string(ChildProcess.make("getconf", ["PAGESIZE"], { stdin: "ignore", stderr: "ignore" }))
          .pipe(
            Effect.map((output) => Number(output.trim())),
            Effect.timeout("5 seconds"),
            Effect.orElseSucceed(() => Number.NaN),
          );
        if (pageSize > 4096) {
          return yield* installationError("download", LARGE_PAGE_KERNEL_MESSAGE);
        }
      }
      const report = (phase: ProviderInstallState["phase"], message: string | null) =>
        SubscriptionRef.update(state, (current) => ({ ...current, phase, message }));
      yield* fs.makeDirectory(versionsDirectory, { recursive: true });
      yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove: true }));
      const destination = path.join(versionsDirectory, releaseId);
      const activate = Effect.fn("AntigravityInstallation.activate")(
        function* () {
          yield* ensureEligible(asset.version);
          const pointerDirectory = yield* fs.makeTempDirectoryScoped({
            directory: managedDirectory,
            prefix: "active.json.",
          });
          const pointerPath = path.join(pointerDirectory, "contents.tmp");
          yield* fs.writeFileString(pointerPath, yield* encodeActiveRelease({ releaseId }), {
            flag: "wx",
            mode: 0o600,
          });
          yield* fs.rename(pointerPath, activePath);
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                phase: "succeeded",
                installedVersion: asset.version,
                message: null,
              }) satisfies ProviderInstallState,
          );
        },
        Effect.scoped,
        Effect.mapError(
          wrapFailure(
            "activate",
            "Could not activate Antigravity. The previous runtime is unchanged. Check for locked files and try again.",
          ),
        ),
        Effect.uninterruptible,
      );

      if (yield* fs.exists(destination)) {
        const existing = yield* completedRelease(releaseId);
        if (existing.version !== asset.version) {
          return yield* installationError(
            "verify",
            "The existing managed release has the wrong version. Remove it before reinstalling.",
          );
        }
        yield* report("verifying", "Checking the installed runtime.");
        yield* validate(existing, asset.version).pipe(
          Effect.scoped,
          Effect.timeout(VALIDATION_TIMEOUT),
        );
        yield* activate();
        return;
      }

      const available = yield* Effect.tryPromise(() =>
        NodeFSP.statfs(versionsDirectory, { bigint: true }),
      ).pipe(Effect.option);
      const required = cli
        ? MAX_DOWNLOAD_BYTES + MAX_EXECUTABLE_BYTES + FREE_SPACE_MARGIN
        : asset.archiveBytes + asset.executable.bytes + asset.harness.bytes + FREE_SPACE_MARGIN;
      if (
        Option.isSome(available) &&
        available.value.bavail * available.value.bsize < BigInt(required)
      ) {
        return yield* installationError(
          "download",
          `Antigravity needs at least ${Math.ceil(required / 1024 / 1024)} MiB of free space to install.`,
        );
      }
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: versionsDirectory,
        prefix: ".install-",
      });
      const archivePath = path.join(staging, "download.zip");
      const pairDirectory = path.join(staging, "runtime");
      yield* fs.makeDirectory(pairDirectory);
      yield* downloadVerifiedArchive({ http, fs, state, asset, archivePath });
      yield* report("extracting", "Extracting the verified runtime.");
      yield* extractRuntime({
        fs,
        path,
        spawner,
        platform,
        environment,
        asset,
        archivePath,
        pairDirectory,
      });
      yield* fs.remove(archivePath);
      const executablePath = path.join(pairDirectory, asset.executable.name);
      const harnessPath = cli ? null : path.join(pairDirectory, asset.harness.name);
      if (platform !== "win32") {
        yield* fs.chmod(executablePath, 0o755);
        if (harnessPath !== null) yield* fs.chmod(harnessPath, 0o755);
      }
      if (!cli && platform === "darwin" && arch === "x64") {
        // Google signs the Intel build with the hardened runtime but no JIT entitlement, so
        // libffi's writable+executable trampolines spin forever. Re-sign ad hoc after the hash check.
        const exitCode = yield* spawner
          .spawn(
            ChildProcess.make(
              "/usr/bin/codesign",
              [
                "--force",
                "--sign",
                "-",
                executablePath,
                ...(harnessPath === null ? [] : [harnessPath]),
              ],
              { stdout: "ignore", stderr: "ignore" },
            ),
          )
          .pipe(
            Effect.flatMap((child) => child.exitCode),
            Effect.scoped,
          );
        if (exitCode !== 0) {
          return yield* installationError(
            "extract",
            "Could not prepare the Antigravity runtime for this Mac. Check that codesign is available.",
          );
        }
      }
      yield* report("verifying", "Checking the downloaded runtime.");
      yield* validate(
        {
          executablePath,
          harnessPath,
          source: "managed",
          version: asset.version,
          managedVersionDirectory: pairDirectory,
        },
        asset.version,
      ).pipe(Effect.scoped, Effect.timeout(VALIDATION_TIMEOUT));
      const record: InstalledRelease = {
        releaseId,
        version: asset.version,
        executable: {
          name: asset.executable.name,
          bytes: Number((yield* fs.stat(executablePath)).size),
        },
        harness:
          cli || harnessPath === null
            ? null
            : { name: asset.harness.name, bytes: Number((yield* fs.stat(harnessPath)).size) },
      };
      yield* fs.writeFileString(
        path.join(pairDirectory, RELEASE_RECORD),
        yield* encodeInstalledRelease(record),
        { flag: "wx", mode: 0o600 },
      );
      yield* fs.rename(pairDirectory, destination).pipe(
        Effect.catch((cause) =>
          completedRelease(releaseId).pipe(
            Effect.flatMap((existing) =>
              existing.version === asset.version
                ? validate(existing, asset.version).pipe(
                    Effect.scoped,
                    Effect.timeout(VALIDATION_TIMEOUT),
                  )
                : Effect.fail(
                    installationError(
                      "activate",
                      "Another installation published a different Antigravity release.",
                    ),
                  ),
            ),
            Effect.mapError(() =>
              installationError(
                "activate",
                "Could not publish the Antigravity runtime. The previous release is unchanged. Try again.",
                cause,
              ),
            ),
          ),
        ),
      );
      yield* activate();
    },
    Effect.scoped,
    Effect.mapError(
      wrapFailure(
        "install",
        "Could not install Antigravity. Check free disk space and directory access, then try again.",
      ),
    ),
  );

  let lastUpdateCheck: number | undefined;
  const refreshRelease = Effect.fn("AntigravityInstallation.refreshRelease")(function* (
    explicit = false,
  ) {
    if (options.releaseAsset !== undefined || !supported) return;
    const now = yield* Clock.currentTimeMillis;
    if (!explicit && lastUpdateCheck !== undefined && now - lastUpdateCheck < UPDATE_CHECK_INTERVAL)
      return;
    lastUpdateCheck = now;
    const latest = yield* lookupAntigravityCliRelease({ http, fs, platform, arch });
    // Nothing usable published keeps the current offer, which was verified when it was read.
    if (latest === null) return;
    if (yield* isWithdrawn(latest.version)) {
      releaseAsset = pinned;
      return;
    }
    releaseAsset = latest;
    yield* SubscriptionRef.updateEffect(state, (value) =>
      isRunning(value)
        ? Effect.succeed(value)
        : Effect.gen(function* () {
            const keepInstalled =
              value.installedVersion !== null &&
              compareSemverVersions(value.installedVersion, latest.version) > 0 &&
              !(yield* isWithdrawn(value.installedVersion));
            return {
              ...value,
              version: keepInstalled ? value.installedVersion : latest.version,
              totalBytes: null,
            };
          }),
    );
  });

  const start = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (isRunning(current)) return current;
    yield* refreshRelease(true);
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (isRunning(current)) return current;
        if (!supported) {
          return yield* installationError(
            "start",
            `Google does not publish an Antigravity runtime for ${platform}-${arch}. Use a supported remote environment or a custom executable.`,
          );
        }
        const offered =
          releaseAsset !== null && !(yield* isWithdrawn(releaseAsset.version))
            ? releaseAsset
            : pinned;
        const asset = offered !== null && !(yield* isWithdrawn(offered.version)) ? offered : null;
        const installed = yield* resolve().pipe(Effect.option);
        // A native CLI install newer than the offer is checked again, never downgraded.
        const reuse =
          Option.isSome(installed) &&
          installed.value.source === "managed" &&
          installed.value.harnessPath === null &&
          installed.value.version !== null &&
          (asset === null || compareSemverVersions(installed.value.version, asset.version) > 0)
            ? { executable: installed.value, version: installed.value.version }
            : undefined;
        if (asset === null && reuse === undefined)
          return yield* installationError(
            "start",
            "No Antigravity release is available to install. Check the network connection and try again.",
          );
        const operationId = yield* crypto.randomUUIDv4();
        const next: ProviderInstallState = {
          driver: DRIVER,
          operationId,
          phase: reuse === undefined ? "downloading" : "verifying",
          downloadedBytes: 0,
          totalBytes: asset !== null && "archiveBytes" in asset ? asset.archiveBytes : null,
          version: reuse?.version ?? asset?.version ?? null,
          installedVersion: current.installedVersion,
          canRemove: current.canRemove,
          message:
            reuse === undefined
              ? "Downloading Google's official Antigravity runtime."
              : "Checking the installed runtime.",
        };
        yield* SubscriptionRef.set(state, next);
        const work = (
          reuse === undefined
            ? asset === null
              ? Effect.void
              : install(asset)
            : validate(reuse.executable, reuse.version).pipe(
                Effect.scoped,
                Effect.timeout(VALIDATION_TIMEOUT),
                Effect.andThen(ensureEligible(reuse.version)),
                Effect.andThen(
                  SubscriptionRef.update(state, (value) => ({
                    ...value,
                    phase: "succeeded" as const,
                    installedVersion: reuse.version,
                    message: null,
                  })),
                ),
              )
        ).pipe(
          Effect.mapError(
            wrapFailure("verify", "Could not verify the installed Antigravity runtime."),
          ),
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? SubscriptionRef.update(state, (value) => {
                  if (value.operationId !== operationId || value.phase === "succeeded")
                    return value;
                  const error = Cause.findErrorOption(exit.cause);
                  const cancelled = Cause.hasInterruptsOnly(exit.cause);
                  return {
                    ...value,
                    phase: cancelled ? "cancelled" : "failed",
                    message: cancelled
                      ? "Installation cancelled. The previous runtime is unchanged."
                      : Option.isSome(error)
                        ? error.value.detail
                        : "Could not finish the Antigravity installation. Check disk space and directory access.",
                  } satisfies ProviderInstallState;
                })
              : Effect.void,
          ),
          Effect.ignoreCause,
          Effect.ensuring(
            Effect.sync(() => {
              if (running?.operationId === operationId) running = undefined;
            }),
          ),
        );
        const fiber = yield* Effect.forkIn(Effect.interruptible(work), serviceScope);
        running = { operationId, fiber };
        return next;
      }).pipe(Effect.uninterruptible),
    );
  }).pipe(Effect.mapError(wrapFailure("start", "Could not start the Antigravity installation.")));

  const cancel = Effect.fn("AntigravityInstallation.cancel")(function* (operationId: string) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.operationId !== operationId) {
          return yield* installationError(
            "cancel",
            "This installation is no longer current. Refresh its status before cancelling.",
          );
        }
        if (running?.operationId === operationId && isRunning(current)) {
          yield* Fiber.interrupt(running.fiber);
        }
        return yield* SubscriptionRef.get(state);
      }),
    );
  });

  const remove = Effect.fn("AntigravityInstallation.remove")(
    function* (protectedBinaryPaths: ReadonlyArray<string> = []) {
      yield* gate.withPermit(
        Effect.gen(function* () {
          if (isRunning(yield* SubscriptionRef.get(state)) || leases.size > 0) {
            return yield* installationError(
              "remove",
              "Stop Antigravity sessions and sign-in flows before removing its managed runtime.",
            );
          }
          const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
          if (Option.isSome(realManaged)) {
            for (const binaryPath of protectedBinaryPaths) {
              if (!binaryPath.trim()) continue;
              const selected = yield* resolve(binaryPath).pipe(Effect.option);
              if (Option.isSome(selected) && selected.value.managedVersionDirectory) {
                return yield* installationError(
                  "remove",
                  "A provider instance has a custom path inside this managed runtime. Clear that path before removing it.",
                );
              }
              const resolved = yield* fs.realPath(binaryPath).pipe(Effect.option);
              const candidate = Option.getOrElse(resolved, () => path.resolve(binaryPath));
              if (candidate.startsWith(`${realManaged.value}${path.sep}`)) {
                return yield* installationError(
                  "remove",
                  "A provider instance has a custom path inside this managed runtime. Clear that path before removing it.",
                );
              }
            }
          }
          yield* fs.remove(managedDirectory, { recursive: true, force: true });
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                operationId: null,
                phase: "idle",
                downloadedBytes: 0,
                installedVersion: null,
                canRemove: false,
                message: null,
              }) satisfies ProviderInstallState,
          );
        }).pipe(Effect.uninterruptible),
      );
    },
    Effect.mapError(
      wrapFailure(
        "remove",
        "Could not remove the managed Antigravity runtime. Check for open processes and try again.",
      ),
    ),
  );

  yield* Effect.gen(function* () {
    const canRemove = yield* fs.exists(managedDirectory);
    yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove }));
    if (!(yield* fs.exists(activePath))) return;
    const active = yield* readRecord(activePath, ActiveRelease);
    const installed = yield* completedRelease(active.releaseId);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      installedVersion: installed.version,
    }));
  }).pipe(
    Effect.catch(() =>
      SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "failed",
            message: "The managed Antigravity runtime is incomplete. Remove it and reinstall.",
          }) satisfies ProviderInstallState,
      ),
    ),
  );

  return AntigravityInstallation.of({
    managedDirectory,
    resolve,
    acquire,
    start,
    cancel,
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    checkForUpdate: refreshRelease().pipe(Effect.ignore),
    remove,
  });
});
