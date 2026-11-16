// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import {
  ProviderDriverKind,
  type ProviderInstallState,
  type ServerProviderCompatibilityAdvisory,
} from "@goat/contracts";
import { compareSemverVersions, satisfiesSemverRange } from "@goat/shared/semver";
import { collectUint8StreamText } from "@goat/shared/collectStreamText";
import { providerProbeEnvironment } from "@goat/provider-core/server/snapshotProbe";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@goat/shared/shell";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeCrypto from "node:crypto";
import * as ServerConfig from "../config.ts";
import { selectManagedRelease } from "./managedRelease.ts";
import { extractCodexPackage } from "./CodexInstallationExtract.ts";
import { UPSTREAM_MAX_ARCHIVE_BYTES, lookupCodexUpstreamRelease } from "./CodexUpstreamRelease.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";
import {
  ActiveRelease,
  CodexInstallationError,
  InstalledRelease,
  PackageManifest,
  STARTUP_STDERR_MAX_BYTES,
  STARTUP_STDOUT_MAX_BYTES,
  STARTUP_WARNINGS,
  decodeStartupConfig,
  decodeVersion,
  encodeActive,
  encodeRecord,
  installationError,
  resolveCodexReleaseAsset,
  wrapFailure,
  type CodexAcquisitionOptions,
  type CodexExecutable,
  type CodexReleaseAsset,
} from "./CodexInstallationRelease.ts";

export { CodexInstallationError };
export type { CodexAcquisitionOptions, CodexExecutable, CodexReleaseAsset };

const DRIVER = ProviderDriverKind.make("codex");
const STAGING_STALE_AFTER_MS = 24 * 60 * 60_000;
const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000;
const UPDATE_CHECK_TIMEOUT = "20 seconds";
interface CodexInstallationService {
  readonly managedDirectory: string;
  readonly resolve: (
    options?: CodexAcquisitionOptions,
  ) => Effect.Effect<CodexExecutable, CodexInstallationError>;
  readonly acquire: (
    options?: CodexAcquisitionOptions,
  ) => Effect.Effect<CodexExecutable, CodexInstallationError, Scope.Scope>;
  readonly compatibility: (
    version: string,
  ) => Effect.Effect<ServerProviderCompatibilityAdvisory | undefined>;
  readonly start: Effect.Effect<ProviderInstallState, CodexInstallationError>;
  /** Installs GOAT's pinned release even when a supported Codex is on PATH. */
  /**
   * Installs or re-checks GOAT's managed release only, whatever runs on PATH. `allowUpdate` false
   * (OpenCodex child setup, which nobody pressed) never moves past the installed release.
   */
  readonly startManagedOnly: (input: {
    readonly allowUpdate: boolean;
  }) => Effect.Effect<ProviderInstallState, CodexInstallationError>;
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ProviderInstallState, CodexInstallationError>;
  readonly state: Effect.Effect<ProviderInstallState>;
  readonly changes: Stream.Stream<ProviderInstallState>;
  /**
   * Looks up OpenAI's newest Codex release, at most hourly, and offers it
   * through `state.version` when it is newer than the managed install.
   */
  readonly checkForUpdate: Effect.Effect<void>;
  readonly remove: (
    protectedBinaryPaths?: ReadonlyArray<string>,
  ) => Effect.Effect<void, CodexInstallationError>;
}
export class CodexInstallation extends Context.Service<
  CodexInstallation,
  CodexInstallationService
>()("goat/provider/CodexInstallation") {
  static readonly layer = Layer.effect(
    CodexInstallation,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return yield* makeCodexInstallation({ baseDir: config.baseDir });
    }),
  );
}
export interface CodexInstallationOptions {
  readonly baseDir: string;
  readonly releaseAsset?: CodexReleaseAsset | null;
  readonly validate?: (
    executable: CodexExecutable,
    expectedVersion: string,
  ) => Effect.Effect<void, CodexInstallationError, Scope.Scope>;
}
const isRunning = (state: ProviderInstallState) =>
  ["downloading", "extracting", "verifying"].includes(state.phase);
export const makeCodexInstallation = Effect.fn("makeCodexInstallation")(function* (
  options: CodexInstallationOptions,
) {
  const manifestService = yield* ModelManifest.ModelManifest;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const arch = yield* HostProcess.Architecture;
  const asset =
    options.releaseAsset === undefined
      ? resolveCodexReleaseAsset(platform, arch)
      : options.releaseAsset;
  const managedDirectory = path.join(options.baseDir, "tools", "codex");
  const activePath = path.join(managedDirectory, "active.json");
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const gate = yield* Semaphore.make(1);
  const updateCheckGate = yield* Semaphore.make(1);
  let leases = 0;
  let running: { readonly operationId: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  let upstream: CodexReleaseAsset | null = null;
  let upstreamCheckedAt: number | null = null;

  // A local Codex is used as is, so only a managed install is ever updated.
  const managedVersion = (current: ProviderInstallState) =>
    current.source === "managed" ? current.installedVersion : null;
  // What `start` installs next. Clients compare `version` with
  // `installedVersion` to offer an update.
  const offer = (installedVersion: string | null) => {
    const release = selectManagedRelease(installedVersion, asset, upstream);
    return {
      version: release?.version ?? installedVersion,
      totalBytes: release?.archiveBytes ?? null,
    };
  };

  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: DRIVER,
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    ...offer(null),
    installedVersion: null,
    executablePath: null,
    canRemove: false,
    message: null,
  });
  const readRecord = Effect.fn("CodexInstallation.readRecord")(function* <A>(
    file: string,
    schema: Schema.Codec<A>,
  ) {
    const info = yield* fs.stat(file);
    if (info.type !== "File" || Number(info.size) > 8192)
      return yield* installationError(
        "resolve",
        "The managed Codex installation record is invalid. Reinstall Codex.",
      );
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
      yield* fs.readFileString(file),
    );
  });
  const fromDirectory = Effect.fn("CodexInstallation.fromDirectory")(function* (
    directory: string,
    version: string,
    target: string,
  ) {
    const manifest = yield* readRecord(path.join(directory, "codex-package.json"), PackageManifest);
    if (
      manifest.version !== version ||
      manifest.target !== target ||
      manifest.entrypoint !== `bin/${executableName}`
    )
      return yield* installationError(
        "verify",
        "The downloaded Codex package does not match the expected release.",
      );
    for (const name of [
      `bin/${executableName}`,
      `bin/codex-code-mode-host${platform === "win32" ? ".exe" : ""}`,
      `codex-path/rg${platform === "win32" ? ".exe" : ""}`,
    ]) {
      const info = yield* fs.stat(path.join(directory, name));
      if (
        info.type !== "File" ||
        Number(info.size) === 0 ||
        (platform !== "win32" && (info.mode & 0o111) === 0)
      )
        return yield* installationError(
          "verify",
          "The managed Codex package is incomplete. Reinstall Codex.",
        );
    }
    return {
      executablePath: path.join(directory, "bin", executableName),
      source: "managed",
      version,
      managedVersionDirectory: directory,
    } satisfies CodexExecutable;
  });
  const completedRelease = Effect.fn("CodexInstallation.completedRelease")(function* (
    version: string,
  ) {
    yield* decodeVersion(version);
    const directory = path.join(managedDirectory, version);
    const record = yield* readRecord(
      path.join(directory, ".install-complete.json"),
      InstalledRelease,
    );
    if (record.version !== version)
      return yield* installationError(
        "resolve",
        "The managed Codex installation record has the wrong version.",
      );
    return yield* fromDirectory(directory, version, record.target);
  });
  const compatibility = Effect.fn("CodexInstallation.compatibility")(function* (version: string) {
    const manifest = yield* manifestService.current;
    return (
      resolveProviderCompatibility(manifest.compatibility, DRIVER, version) ??
      resolveProviderCompatibility(
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
        DRIVER,
        version,
      )
    );
  });
  const isSupported = (version: string) =>
    compatibility(version).pipe(Effect.map((advisory) => advisory?.status === "supported"));
  // Forgets what the manifest withdrew after it was seen. Managed resolution
  // refuses a withdrawn install, so the pin replaces it rather than a re-check.
  const keptInstall = Effect.fn("CodexInstallation.keptInstall")(function* (
    installedVersion: string | null,
  ) {
    if (upstream && !(yield* isSupported(upstream.version))) upstream = null;
    return installedVersion !== null && (yield* isSupported(installedVersion))
      ? installedVersion
      : null;
  });
  const lookupUpstream = asset
    ? lookupCodexUpstreamRelease({ http, target: asset.target, isSupported })
    : Effect.succeed(null);
  // A check already in flight covers concurrent subscribers, including when it fails.
  const checkForUpdate = updateCheckGate
    .withPermitsIfAvailable(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (upstreamCheckedAt === null || now - upstreamCheckedAt >= UPDATE_CHECK_INTERVAL_MS) {
          // A failed lookup counts too, and keeps whatever release was offered before.
          upstreamCheckedAt = now;
          upstream = yield* lookupUpstream.pipe(
            Effect.timeout(UPDATE_CHECK_TIMEOUT),
            Effect.orElseSucceed(() => upstream),
          );
        }
        // A running install already published the release it is installing.
        yield* SubscriptionRef.updateEffect(state, (current) =>
          isRunning(current)
            ? Effect.succeed(current)
            : keptInstall(managedVersion(current)).pipe(
                Effect.map((kept) => ({ ...current, ...offer(kept) })),
              ),
        );
      }),
    )
    .pipe(Effect.ignore);
  const resolveManaged = Effect.fn("CodexInstallation.resolveManaged")(
    function* () {
      const active = yield* readRecord(activePath, ActiveRelease);
      const executable = yield* completedRelease(active.version);
      const advisory = yield* compatibility(executable.version);
      if (advisory?.status !== "supported")
        return yield* installationError(
          "resolve",
          advisory?.message ?? "Update the managed Codex installation to continue.",
        );
      return executable;
    },
    Effect.mapError(
      wrapFailure("resolve", "Codex is not installed in GOAT. Install it to continue."),
    ),
  );
  const acquire = Effect.fn("CodexInstallation.acquire")(function* (
    options?: CodexAcquisitionOptions,
  ) {
    return yield* Effect.acquireRelease(
      gate.withPermit(
        resolve(options, false).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              leases += 1;
            }),
          ),
        ),
      ),
      () =>
        Effect.sync(() => {
          leases -= 1;
        }),
    );
  });
  const runCommand = Effect.fn("CodexInstallation.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
    env?: NodeJS.ProcessEnv,
  ) {
    const resolved = yield* resolveSpawnCommand(
      command,
      args,
      env === undefined ? {} : { env },
    ).pipe(Effect.provideService(HostProcess.Platform, platform));
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        shell: resolved.shell,
        ...(env === undefined ? {} : { env }),
      }),
    );
    const [output, , exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.runDrain),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0)
      return yield* installationError(
        "verify",
        "Could not unpack or start the downloaded Codex package.",
      );
    return output;
  }, Effect.scoped);
  const probeStartupConfig = Effect.fn("CodexInstallation.probeStartupConfig")(
    function* (executablePath: string) {
      const env = providerProbeEnvironment(environment);
      const resolved = yield* resolveSpawnCommand(
        executablePath,
        ["app-server", "--print-startup-config"],
        { env },
      ).pipe(Effect.provideService(HostProcess.Platform, platform));
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, { shell: resolved.shell, env }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: STARTUP_STDOUT_MAX_BYTES }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: STARTUP_STDERR_MAX_BYTES }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (stdout.truncated || stdout.invalidUtf8) return STARTUP_WARNINGS.invalid;
      const response = decodeStartupConfig(stdout.text);
      if (Option.isSome(response)) {
        if ("error" in response.value)
          return exitCode !== 0 ? STARTUP_WARNINGS.configuration : STARTUP_WARNINGS.invalid;
        return exitCode === 0 ? undefined : STARTUP_WARNINGS.invalid;
      }
      if (
        exitCode !== 0 &&
        !stderr.truncated &&
        !stderr.invalidUtf8 &&
        /(?:unexpected argument|unrecognized (?:option|argument)) ['"]?--print-startup-config\b/iu.test(
          stderr.text,
        )
      )
        return STARTUP_WARNINGS.unsupported;
      return STARTUP_WARNINGS.invalid;
    },
    Effect.scoped,
    Effect.orElseSucceed(() => STARTUP_WARNINGS.unavailable),
  );
  // Native Codex needs its adjacent host; launchers resolve their own payloads.
  const hasCodeModeHost = Effect.fn("CodexInstallation.hasCodeModeHost")(
    function* (realExecutablePath: string) {
      if (/^(?:volta-shim|mise|aqua-proxy)(?:\.exe)?$/iu.test(path.basename(realExecutablePath)))
        return true;
      if (platform === "win32") {
        if (path.extname(realExecutablePath).toLowerCase() !== ".exe") return true;
        for (const extension of [".bunx", ".shim"]) {
          const marker = yield* fs
            .stat(realExecutablePath.slice(0, -4) + extension)
            .pipe(Effect.option);
          if (
            Option.isSome(marker) &&
            marker.value.type === "File" &&
            Number(marker.value.size) > 0
          )
            return true;
        }
      } else {
        const header = yield* fs.open(realExecutablePath, { flag: "r" }).pipe(
          Effect.flatMap((file) => file.readAlloc(2)),
          Effect.orElseSucceed(() => Option.none()),
        );
        if (Option.isSome(header) && header.value[0] === 0x23 && header.value[1] === 0x21)
          return true;
      }
      const info = yield* fs.stat(
        path.join(
          path.dirname(realExecutablePath),
          `codex-code-mode-host${platform === "win32" ? ".exe" : ""}`,
        ),
      );
      return (
        info.type === "File" &&
        Number(info.size) > 0 &&
        (platform === "win32" || (info.mode & 0o111) !== 0)
      );
    },
    Effect.scoped,
    Effect.orElseSucceed(() => false),
  );
  const localCache = new Map<
    string,
    { fingerprint: string; executable: Omit<CodexExecutable, "startupWarning"> | null }
  >();
  const resolveLocal = Effect.fn("CodexInstallation.resolveLocal")(
    function* (diagnose: boolean) {
      const executablePath = yield* resolveCommandPath("codex", { env: environment }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      if (executablePath === null) return null;
      // Keep launcher symlinks intact: version-manager shims dispatch by their invoked name.
      const realExecutablePath = yield* fs.realPath(executablePath);
      const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
      if (
        realExecutablePath.startsWith(
          `${Option.getOrElse(realManaged, () => managedDirectory)}${path.sep}`,
        )
      )
        return null;
      if (!(yield* hasCodeModeHost(realExecutablePath))) return null;
      const info = yield* fs.stat(executablePath);
      const fingerprint = `${realExecutablePath}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}:${Option.getOrUndefined(info.ino)}`;
      const cached = localCache.get(executablePath);
      let candidate = cached?.fingerprint === fingerprint ? cached.executable : undefined;
      let startupCandidate: CodexExecutable | null = null;
      const executable = yield* Effect.gen(function* () {
        if (candidate === undefined) {
          const output = yield* runCommand(
            executablePath,
            ["--version"],
            diagnose ? providerProbeEnvironment(environment) : undefined,
          );
          const version = /^codex-cli (\d+\.\d+\.\d+)$/u.exec(output.trim())?.[1];
          if (!version) return null;
          // Prereleases retain the existing conservative version policy. The
          // stable gate stays off until 0.164; 0.163 has no one-shot flag.
          if (!satisfiesSemverRange(version, ">=0.164.0"))
            yield* runCommand(
              executablePath,
              ["app-server", "--help"],
              diagnose ? providerProbeEnvironment(environment) : undefined,
            );
          candidate = { executablePath, source: "local", version, managedVersionDirectory: null };
        }
        if (!candidate || !diagnose || !satisfiesSemverRange(candidate.version, ">=0.164.0"))
          return candidate ?? null;
        startupCandidate = candidate;
        const startupWarning = yield* probeStartupConfig(executablePath);
        return { ...candidate, ...(startupWarning ? { startupWarning } : {}) };
      }).pipe(
        Effect.timeout("5 seconds"),
        // Keep the one overall budget, but a diagnostic timeout must not
        // turn a version-confirmed executable into a missing installation.
        Effect.catchTags({
          TimeoutError: () =>
            Effect.succeed(
              startupCandidate
                ? { ...startupCandidate, startupWarning: STARTUP_WARNINGS.timeout }
                : null,
            ),
        }),
        Effect.orElseSucceed(() => null),
      );
      // Config and cloud requirements can change without touching the binary.
      // Cache discovery only; every status resolution gets a fresh diagnostic.
      if (candidate) localCache.set(executablePath, { fingerprint, executable: candidate });
      if (!executable) return null;
      const advisory = yield* compatibility(executable.version);
      return advisory?.status === "supported" ? executable : null;
    },
    Effect.orElseSucceed(() => null),
  );
  const resolve = Effect.fn("CodexInstallation.resolve")(function* (
    options?: CodexAcquisitionOptions,
    diagnose = true,
  ) {
    if (options?.managedOnly) return yield* resolveManaged();
    // Runtime leases use initialize as their authority, without repeating the
    // advisory config request already made by the status check.
    const local = yield* resolveLocal(diagnose);
    return local ?? (yield* resolveManaged());
  });
  const reuseLocal = Effect.fn("CodexInstallation.reuseLocal")(function* () {
    const local = yield* resolveLocal(true);
    if (!local) return false;
    yield* SubscriptionRef.update(
      state,
      (current) =>
        ({
          ...current,
          phase: "succeeded",
          source: "local",
          operationId: null,
          installedVersion: local.version,
          executablePath: local.executablePath,
          downloadedBytes: 0,
          totalBytes: null,
          message: null,
        }) satisfies ProviderInstallState,
    );
    return true;
  });
  const validate =
    options.validate ??
    Effect.fn("CodexInstallation.validate")(
      function* (executable: CodexExecutable, version: string) {
        const output = yield* runCommand(executable.executablePath, ["--version"]);
        if (output.trim() !== `codex-cli ${version}`)
          return yield* installationError(
            "verify",
            "The downloaded Codex executable has the wrong version.",
          );
      },
      Effect.mapError(wrapFailure("verify", "The downloaded Codex runtime could not start.")),
    );
  const install = Effect.fn("CodexInstallation.install")(
    function* (release: CodexReleaseAsset) {
      const ensureEligible = Effect.fn("CodexInstallation.ensureEligible")(function* () {
        if (release.version !== asset?.version && !(yield* isSupported(release.version))) {
          return yield* installationError(
            "verify",
            "This Codex release was withdrawn. Check for updates and try again.",
          );
        }
      });
      yield* decodeVersion(release.version);
      yield* fs.makeDirectory(managedDirectory, { recursive: true });
      yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove: true }));
      const destination = path.join(managedDirectory, release.version);
      const activate = Effect.fn("CodexInstallation.activate")(
        function* () {
          const executable = yield* completedRelease(release.version);
          const temporary = yield* fs.makeTempDirectoryScoped({
            directory: managedDirectory,
            prefix: ".active-",
          });
          const pointer = path.join(temporary, "active.json");
          yield* fs.writeFileString(pointer, yield* encodeActive({ version: release.version }), {
            mode: 0o600,
            flag: "wx",
          });
          yield* ensureEligible();
          yield* fs.rename(pointer, activePath);
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                ...offer(release.version),
                phase: "succeeded",
                source: "managed",
                installedVersion: release.version,
                executablePath: executable.executablePath,
                message: null,
              }) satisfies ProviderInstallState,
          );
        },
        Effect.scoped,
        Effect.uninterruptible,
      );
      if (yield* fs.exists(destination)) {
        const existing = yield* completedRelease(release.version);
        const record = yield* readRecord(
          path.join(destination, ".install-complete.json"),
          InstalledRelease,
        );
        if (record.sha256 !== release.sha256 || record.target !== release.target)
          return yield* installationError(
            "verify",
            "The existing managed Codex release differs from the official package. Remove it and reinstall.",
          );
        yield* ensureEligible();
        yield* validate(existing, release.version).pipe(
          Effect.scoped,
          Effect.timeout("90 seconds"),
        );
        yield* activate();
        return;
      }
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: managedDirectory,
        prefix: ".install-",
      });
      const archivePath = path.join(staging, "download.tar.gz");
      const runtime = path.join(staging, "runtime");
      yield* fs.makeDirectory(runtime);
      const hash = NodeCrypto.createHash("sha256");
      const maxArchiveBytes = release.archiveBytes ?? UPSTREAM_MAX_ARCHIVE_BYTES;
      let downloadedBytes = 0;
      let lastProgressAt = yield* Clock.currentTimeMillis;
      const response = yield* http
        .execute(HttpClientRequest.get(release.url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            downloadedBytes += chunk.byteLength;
            if (downloadedBytes > maxArchiveBytes)
              return yield* installationError(
                "download",
                "The Codex download exceeded the expected release size.",
              );
            hash.update(chunk);
            const now = yield* Clock.currentTimeMillis;
            if (now - lastProgressAt >= 250 || downloadedBytes === release.archiveBytes) {
              lastProgressAt = now;
              yield* SubscriptionRef.update(state, (current) => ({ ...current, downloadedBytes }));
            }
          }),
        ),
        Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
        Effect.timeout("45 minutes"),
        Effect.catchTags({
          TimeoutError: (cause) =>
            installationError(
              "download",
              "The Codex download timed out. Retry installation.",
              cause,
            ),
        }),
      );
      if (
        (release.archiveBytes !== null && downloadedBytes !== release.archiveBytes) ||
        hash.digest("hex") !== release.sha256
      )
        return yield* installationError(
          "download",
          "The Codex download failed its size or SHA-256 check. Nothing was installed.",
        );
      yield* SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "extracting",
            message: "Extracting Codex.",
          }) satisfies ProviderInstallState,
      );
      yield* extractCodexPackage({
        fs,
        path,
        spawner,
        platform,
        environment,
        run: runCommand,
        archivePath,
        runtime,
      });
      yield* SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "verifying",
            message: "Checking Codex.",
          }) satisfies ProviderInstallState,
      );
      const executable = yield* fromDirectory(runtime, release.version, release.target);
      yield* ensureEligible();
      yield* validate(executable, release.version).pipe(
        Effect.scoped,
        Effect.timeout("90 seconds"),
      );
      yield* fs.writeFileString(
        path.join(runtime, ".install-complete.json"),
        yield* encodeRecord({
          version: release.version,
          target: release.target,
          sha256: release.sha256,
        }),
        { flag: "wx", mode: 0o600 },
      );
      // Windows Defender or process rundown may retain codex.exe handles briefly after --version exits.
      const renameRuntime = fs.rename(runtime, destination);
      yield* platform === "win32"
        ? renameRuntime.pipe(Effect.retry({ times: 10, schedule: Schedule.spaced("100 millis") }))
        : renameRuntime;
      yield* activate();
    },
    Effect.scoped,
    Effect.catchTags({
      HttpClientError: (cause) => {
        const httpStatus =
          cause.reason._tag === "StatusCodeError" ? cause.reason.response.status : undefined;
        return new CodexInstallationError({
          operation: "download",
          detail:
            httpStatus === undefined
              ? "The Codex download was interrupted. Check your internet connection, then retry installation."
              : `The Codex download server returned HTTP ${httpStatus}. Try again later.`,
          cause,
        });
      },
    }),
    Effect.mapError(
      wrapFailure(
        "install",
        "Could not install Codex. Check disk space and directory access, then try again.",
      ),
    ),
  );
  // Nothing newer is known, so "reinstall" re-checks the active runtime rather
  // than replacing it with an older pinned release.
  const reverify = Effect.fn("CodexInstallation.reverify")(
    function* () {
      const active = yield* readRecord(activePath, ActiveRelease);
      const executable = yield* completedRelease(active.version);
      yield* validate(executable, executable.version).pipe(
        Effect.scoped,
        Effect.timeout("90 seconds"),
      );
      const kept = yield* keptInstall(executable.version);
      if (kept === null) {
        yield* SubscriptionRef.update(state, (current) => ({ ...current, ...offer(kept) }));
        return yield* installationError(
          "verify",
          "This Codex release was withdrawn. Check for updates and try again.",
        );
      }
      yield* SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            ...offer(kept),
            phase: "succeeded",
            source: "managed",
            installedVersion: executable.version,
            executablePath: executable.executablePath,
            message: null,
          }) satisfies ProviderInstallState,
      );
    },
    Effect.mapError(
      wrapFailure(
        "verify",
        "The installed Codex runtime could not start. Remove it and reinstall.",
      ),
    ),
  );
  // Managed-only work reads the release active.json names; the shared state can name a local Codex.
  const activeManagedVersion = readRecord(activePath, ActiveRelease).pipe(
    Effect.map((active): string | null => active.version),
    Effect.orElseSucceed(() => null),
  );
  const startWith = (managedOnly: boolean, allowUpdate = true) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (isRunning(current)) return current;
          if (!managedOnly && (yield* reuseLocal())) return yield* SubscriptionRef.get(state);
          const installedVersion = yield* keptInstall(
            managedOnly ? yield* activeManagedVersion : managedVersion(current),
          );
          const release = selectManagedRelease(
            installedVersion,
            asset,
            allowUpdate ? upstream : null,
          );
          if (!release && installedVersion === null) {
            return yield* installationError(
              "start",
              `OpenAI does not publish a Codex runtime for ${platform}-${arch}. Use a supported remote environment or a custom executable.`,
            );
          }
          const operationId = yield* crypto.randomUUIDv4();
          const next: ProviderInstallState = {
            ...current,
            operationId,
            phase: release ? "downloading" : "verifying",
            downloadedBytes: 0,
            ...offer(installedVersion),
            message: release ? "Downloading Codex." : "Checking Codex.",
          };
          yield* SubscriptionRef.set(state, next);
          const work = (release ? install(release) : reverify()).pipe(
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
                          : "Could not finish the Codex installation. Check disk space and directory access.",
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
      )
      .pipe(Effect.mapError(wrapFailure("start", "Could not start the Codex installation.")));
  const start = startWith(false);
  const startManagedOnly = (input: { readonly allowUpdate: boolean }) =>
    startWith(true, input.allowUpdate);

  const cancel = Effect.fn("CodexInstallation.cancel")(function* (operationId: string) {
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

  const remove = Effect.fn("CodexInstallation.remove")(
    function* (protectedBinaryPaths: ReadonlyArray<string> = []) {
      yield* gate.withPermit(
        Effect.gen(function* () {
          if (isRunning(yield* SubscriptionRef.get(state)) || leases > 0) {
            return yield* installationError(
              "remove",
              "Stop Codex sessions and sign-in flows before removing its managed runtime.",
            );
          }
          const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
          if (Option.isSome(realManaged)) {
            for (const binary of protectedBinaryPaths) {
              const resolved = yield* fs.realPath(binary).pipe(Effect.option);
              const candidate = Option.getOrElse(resolved, () => path.resolve(binary));
              if (candidate.startsWith(`${realManaged.value}${path.sep}`))
                return yield* installationError(
                  "remove",
                  "A provider instance uses a custom path inside managed Codex. Clear that path before removing it.",
                );
            }
          }
          yield* fs.remove(managedDirectory, { recursive: true, force: true });
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                ...offer(null),
                operationId: null,
                phase: "idle",
                downloadedBytes: 0,
                installedVersion: null,
                executablePath: null,
                source: null,
                canRemove: false,
                message: null,
              }) satisfies ProviderInstallState,
          );
          yield* reuseLocal();
        }).pipe(Effect.uninterruptible),
      );
    },
    Effect.mapError(
      wrapFailure(
        "remove",
        "Could not remove the managed Codex runtime. Check for open processes and try again.",
      ),
    ),
  );

  yield* Effect.gen(function* () {
    // Shared-home installs do not refresh parent mtimes; remove only staging directories far older than the 45-minute download cap.
    let canRemove = false;
    if (yield* fs.exists(managedDirectory)) {
      const entries = yield* fs
        .readDirectory(managedDirectory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const now = yield* Clock.currentTimeMillis;
      for (const entry of entries) {
        if (!entry.startsWith(".install-") && !entry.startsWith(".active-")) continue;
        const target = path.join(managedDirectory, entry);
        const info = yield* fs.stat(target).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        const modifiedAt = Option.match(info.value.mtime, {
          onNone: () => now,
          onSome: (date) => date.getTime(),
        });
        if (now - modifiedAt < STAGING_STALE_AFTER_MS) continue;
        yield* fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore);
      }
      // Keep the empty root to avoid racing new staging directories; unreadable roots remain removable.
      const remaining = yield* fs.readDirectory(managedDirectory).pipe(Effect.option);
      canRemove = Option.isNone(remaining) || remaining.value.length > 0;
    }
    yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove }));
    if (yield* reuseLocal()) return;
    if (!(yield* fs.exists(activePath))) return;
    const active = yield* readRecord(activePath, ActiveRelease);
    const installed = yield* completedRelease(active.version);
    const kept = yield* keptInstall(installed.version);
    yield* SubscriptionRef.update(
      state,
      (current) =>
        ({
          ...current,
          ...offer(kept),
          installedVersion: installed.version,
          executablePath: installed.executablePath,
          source: "managed",
        }) satisfies ProviderInstallState,
    );
    if (asset && compareSemverVersions(installed.version, asset.version) < 0)
      yield* start.pipe(Effect.ignore);
  }).pipe(
    Effect.catch(() =>
      SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "failed",
            message: "The managed Codex runtime is incomplete. Remove it and reinstall.",
          }) satisfies ProviderInstallState,
      ),
    ),
  );

  return CodexInstallation.of({
    managedDirectory,
    resolve,
    acquire,
    compatibility,
    start,
    startManagedOnly,
    cancel,
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    checkForUpdate,
    remove,
  });
});
