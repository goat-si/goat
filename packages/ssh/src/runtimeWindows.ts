import {
  AuthSessionId,
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
  type RuntimeSessionRequest,
} from "@goat/contracts";
import { parseSemver } from "@goat/shared/semver";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ExistingServerProbe } from "./appServer.ts";
import type * as SshAuth from "./auth.ts";
import { runSshCommand } from "./command.ts";
import { SshCommandError, SshLaunchError, SshPairingError } from "./errors.ts";
import {
  matchesSignals,
  notifyRuntimePhase,
  type PreparedRemoteRuntime,
  type RemoteGoatRunnerOptions,
  requestedRuntime,
  RuntimeSignals,
  type SshRuntimeProgressCallback,
} from "./remoteRuntime.ts";
import { readLocalRuntimeArchive } from "./runtimeArchive.ts";
import { downloadRuntimeArchiveWithGh } from "./runtimeArchiveGh.ts";
import { downloadRuntimeArchiveWithHttps } from "./runtimeArchiveHttp.ts";
import { runtimePreparationError } from "./runtimePreparationErrors.ts";
import {
  powershellCommand,
  WINDOWS_DETECT,
  WINDOWS_LOADER,
  WINDOWS_OPERATIONS,
  WINDOWS_SUPERVISOR,
  windowsFrame,
} from "./runtimeWindowsScripts.ts";

/**
 * The installed goat.exe a native Windows host runs, and once launched the process, environment
 * and instance it answers as. Every later operation names it, and the host refuses a stale one.
 */
export const NativeWindowsSelection = Schema.Struct({
  version: Schema.String,
  executablePath: Schema.String.check(Schema.isPattern(/^[A-Za-z]:\\[^\0\r\n]+\\goat\.exe$/u)),
  baseDir: Schema.String.check(Schema.isPattern(/^[A-Za-z]:\\[^\0\r\n]+$/u)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  pid: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4294967295 }))),
  birth: Schema.optionalKey(Schema.String),
  environmentId: Schema.optionalKey(EnvironmentId),
  instanceId: Schema.optionalKey(Schema.String),
  nonce: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u))),
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
});
export type NativeWindowsSelection = typeof NativeWindowsSelection.Type;

const NativeState = Schema.Struct({
  selection: Schema.NullOr(NativeWindowsSelection),
  live: Schema.Boolean,
  reused: Schema.optionalKey(Schema.Boolean),
  signals: Schema.optionalKey(RuntimeSignals),
  binarySignals: Schema.optionalKey(RuntimeSignals),
});
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeState));
const decodeAcknowledged = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ acknowledged: Schema.Literal(true) })),
);
const decodeRevoked = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ sessionId: AuthSessionId, revoked: Schema.Boolean })),
);
const decodeIssued = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ sessionId: AuthSessionId })),
);

const CONSTRAINED =
  "PowerShell on this Windows host runs in Constrained Language Mode. GOAT and OpenCodex Remote Link need Full Language mode for this account.";
const failure = (message: string, cause?: unknown) =>
  new SshLaunchError({ message, stdout: "", ...(cause === undefined ? {} : { cause }) });
type Auth = SshAuth.SshAuthOptions & { readonly preHostArgs?: ReadonlyArray<string> };

/**
 * Whether the host is native Windows: PowerShell answers there whether OpenSSH starts cmd.exe or
 * PowerShell. A dropped connection is not an answer; a constrained PowerShell is refused here.
 */
export const detectNativeWindows = Effect.fn("ssh.windows.detect")(function* (
  target: DesktopSshEnvironmentTarget,
  auth: Auth,
) {
  const stdout = yield* runSshCommand(target, {
    ...auth,
    remoteCommandArgs: powershellCommand(WINDOWS_DETECT),
    timeoutMs: 20_000,
  }).pipe(
    Effect.map((result) => result.stdout),
    Effect.catchTags({
      SshCommandError: (error) =>
        error.exitCode === null || error.exitCode === 255 ? Effect.fail(error) : Effect.succeed(""),
    }),
  );
  const mode = /GOAT_NATIVE_WINDOWS=(\w+)/u.exec(stdout)?.[1];
  if (mode === undefined) return false;
  if (mode !== "FullLanguage") return yield* failure(CONSTRAINED);
  return true;
});

/** What a recovered POSIX command answers on a native Windows host: take the native path. */
export const NATIVE_WINDOWS: unique symbol = Symbol("goat/ssh/nativeWindows");

/**
 * Recovers a POSIX command that failed to start: on a native Windows host it answers
 * NATIVE_WINDOWS so the caller takes the native path, and otherwise the original failure stands.
 */
export const nativeWindowsAfter =
  (target: DesktopSshEnvironmentTarget, auth: Auth) => (error: SshCommandError) =>
    error.exitCode === null || error.exitCode === 255
      ? Effect.fail(error)
      : detectNativeWindows(target, auth).pipe(
          Effect.catchTags({ SshCommandError: () => Effect.fail(error) }),
          Effect.flatMap((native) =>
            native ? Effect.succeed(NATIVE_WINDOWS) : Effect.fail(error),
          ),
        );

/** Runs `native` instead of a POSIX command whose sh could not start on native Windows. */
export const orNativeWindows =
  <B, E2, R2>(target: DesktopSshEnvironmentTarget, auth: Auth, native: Effect.Effect<B, E2, R2>) =>
  <A, E, R>(posix: Effect.Effect<A, E | SshCommandError, R>) =>
    posix.pipe(
      Effect.catchIf(
        (error): error is SshCommandError => error instanceof SshCommandError,
        (error) => nativeWindowsAfter(target, auth)(error).pipe(Effect.andThen(native)),
      ),
    );

const OPERATION_TIMEOUT_MS = { install: 900_000, launch: 80_000 } as const;

/** One framed native operation over the same pinned SSH command path as every POSIX one. */
export const nativeWindowsCommand = Effect.fn("ssh.windows.command")(function* (
  target: DesktopSshEnvironmentTarget,
  auth: Auth,
  request: { readonly op: string } & Readonly<Record<string, unknown>>,
  archive = new Uint8Array(),
) {
  const stdin = yield* Effect.try({
    try: () => windowsFrame(WINDOWS_OPERATIONS, request, archive),
    catch: (cause) => failure("The native Windows request exceeds its size budget.", cause),
  });
  return yield* runSshCommand(target, {
    ...auth,
    remoteCommandArgs: powershellCommand(WINDOWS_LOADER),
    stdin,
    ...(request.op === "install" || request.op === "launch"
      ? { timeoutStage: `runtime-${request.op}` as const }
      : { timeoutStage: "pairing" as const }),
    timeoutMs:
      request.op === "install" || request.op === "launch"
        ? OPERATION_TIMEOUT_MS[request.op]
        : 60_000,
  }).pipe(
    Effect.catchTags({
      SshCommandError: (error) => {
        const reason = /GOAT_NATIVE_ERROR=([a-z-]+)/u.exec(error.stderr)?.[1];
        return Effect.fail(
          reason === undefined
            ? error
            : failure(
                `GOAT's native Windows ${request.op} on ${target.alias} stopped (${reason}); its runtime and data were left as they were.`,
                error,
              ),
        );
      },
    }),
  );
});

const parseState = (stdout: string) =>
  decodeState(stdout.trim()).pipe(
    Effect.mapError((cause) => failure("The native Windows runtime answered unexpectedly.", cause)),
  );

export const inspectWindowsRuntime = Effect.fn("ssh.windows.inspect")(function* (
  target: DesktopSshEnvironmentTarget,
  auth: Auth,
  version: string,
) {
  const result = yield* nativeWindowsCommand(target, auth, { op: "inspect", version });
  return yield* parseState(result.stdout);
});

/**
 * Selects an installed goat.exe, or uploads this build's verified win32-x64 archive. Mirrors,
 * Node script runners and runtime replacement are refused rather than silently substituted.
 */
export const prepareWindowsRuntime = Effect.fn("ssh.windows.prepare")(function* (
  target: DesktopSshEnvironmentTarget,
  auth: Auth,
  runner: RemoteGoatRunnerOptions | undefined,
  onPhase?: SshRuntimeProgressCallback,
) {
  const version = runner?.archiveVersion?.trim() ?? "";
  if (parseSemver(version) === null || runner?.releaseBaseUrl?.trim())
    return yield* failure(
      `${target.alias} runs Windows without a POSIX shell, which GOAT supports only from a published release archive.`,
    );
  if (runner?.confirmReplacement === true || runner?.manualRefresh === true)
    return yield* failure(
      `GOAT cannot replace a runtime on native Windows yet. Stop it on ${target.alias} when its work is done, then reconnect.`,
    );
  notifyRuntimePhase(target, "checking", onPhase);
  let state = yield* inspectWindowsRuntime(target, auth, version);
  if (state.selection === null) {
    if (runner?.keepExistingRunner === true)
      return yield* failure(`GOAT is not installed on ${target.alias}.`);
    // The same bundle, cache, HTTPS and gh sources as POSIX, with their integrity checks.
    const archive = yield* Effect.gen(function* () {
      const bundle = runner?.bundledArchiveDirectory?.trim();
      const directory = runner?.archiveDirectory?.trim();
      const bundled = bundle
        ? yield* readLocalRuntimeArchive(bundle, version, "win32-x64", true)
        : null;
      const cached =
        bundled ??
        (directory ? yield* readLocalRuntimeArchive(directory, version, "win32-x64") : null);
      if (cached !== null) return cached;
      if (!directory)
        return yield* failure(`No GOAT ${version} archive for Windows is available to upload.`);
      const viaGh = downloadRuntimeArchiveWithGh(
        directory,
        version,
        "win32-x64",
        runner?.ghCommand,
      );
      return yield* downloadRuntimeArchiveWithHttps(directory, version, "win32-x64").pipe(
        Effect.catchTags({
          RuntimeArchiveNotPublished: () => viaGh,
          RuntimeArchiveNetworkError: () => viaGh,
        }),
      );
    }).pipe(Effect.mapError(runtimePreparationError));
    notifyRuntimePhase(target, "uploading", onPhase);
    const installed = yield* nativeWindowsCommand(
      target,
      auth,
      { op: "install", version, bytes: archive.bytes.byteLength, sha256: archive.sha256 },
      archive.bytes,
    );
    state = yield* parseState(installed.stdout);
  }
  const selected = state.selection;
  if (
    selected === null ||
    state.binarySignals === undefined ||
    state.binarySignals.serverVersion !== selected.version ||
    !matchesSignals(state.binarySignals, version) ||
    (state.live &&
      (state.signals === undefined ||
        state.signals.serverVersion !== selected.version ||
        !matchesSignals(state.signals, version)))
  )
    return yield* failure(
      `GOAT ${selected?.version ?? "unknown"} on ${target.alias} cannot serve this app's protocol.`,
    );
  return {
    ...requestedRuntime(runner),
    runner: { ...runner, archiveVersion: selected.version },
    version: selected.version,
    source: state.live ? "live" : "installed",
    hostPlatform: "win32",
    requireInstalled: true,
    mayUpgradeOwnedServer: false,
    installedExecutableSha256: selected.sha256,
    nativeWindows: selected,
    ...(selected.version === version
      ? {}
      : { updateBlocked: "GOAT does not replace a runtime on native Windows automatically." }),
  } satisfies PreparedRemoteRuntime;
});

/**
 * Starts the selected goat.exe under its detached supervisor, or reuses the live one, then
 * acknowledges a fresh start so the supervisor keeps it. Answers as a managed launch.
 */
export const launchWindowsRuntime = Effect.fn("ssh.windows.launch")(function* (
  target: DesktopSshEnvironmentTarget,
  auth: Auth,
  selected: PreparedRemoteRuntime,
) {
  const selection = selected.nativeWindows;
  if (selection === undefined) return yield* failure("No native Windows runtime is selected.");
  const uuid = yield* (yield* Crypto.Crypto)
    .randomUUIDv4()
    .pipe(Effect.mapError((cause) => failure("No launch nonce could be generated.", cause)));
  const result = yield* nativeWindowsCommand(target, auth, {
    op: "launch",
    selection,
    nonce: uuid.replaceAll("-", ""),
    supervisor: WINDOWS_SUPERVISOR,
  });
  const launched = yield* parseState(result.stdout);
  const owner = launched.selection;
  if (
    !launched.live ||
    owner === null ||
    owner.port === undefined ||
    owner.environmentId === undefined ||
    owner.instanceId === undefined ||
    owner.nonce === undefined ||
    owner.executablePath !== selection.executablePath ||
    owner.sha256 !== selection.sha256 ||
    owner.version !== selection.version
  )
    return yield* failure(`GOAT on ${target.alias} did not start as the selected runtime.`);
  if (launched.reused !== true) {
    const acknowledged = yield* nativeWindowsCommand(target, auth, { op: "ack", selection: owner });
    yield* decodeAcknowledged(acknowledged.stdout.trim()).pipe(
      Effect.mapError((cause) => failure("The native Windows launch was not acknowledged.", cause)),
    );
  }
  return {
    status: "ready" as const,
    remotePort: owner.port,
    remoteServerKind: "managed" as const,
    selectedRuntime: { ...selected, nativeWindows: owner },
  };
});

/**
 * Issues or revokes a credential through the selected goat.exe's own runtime endpoint. An issued
 * session must name its id; a revocation must acknowledge exactly the requested one.
 */
export const issueWindowsCredential = Effect.fn("ssh.windows.credential")(function* (
  target: DesktopSshEnvironmentTarget,
  auth: Auth,
  selection: NativeWindowsSelection,
  request: RuntimeSessionRequest,
) {
  if (selection.environmentId === undefined || selection.instanceId === undefined)
    return yield* failure(`GOAT on ${target.alias} has not been launched.`);
  const result = yield* nativeWindowsCommand(target, auth, { op: "session", selection, request });
  const body = result.stdout.trim();
  if (request.kind === "revoke") {
    const reply = yield* decodeRevoked(body).pipe(
      Effect.mapError((cause) =>
        failure("The native Windows revocation was not acknowledged.", cause),
      ),
    );
    if (reply.sessionId !== request.sessionId)
      return yield* failure("The native Windows host acknowledged a different session.");
  } else if (request.kind === "session")
    yield* decodeIssued(body).pipe(
      Effect.mapError((cause) => failure("The native Windows session has no issuer id.", cause)),
    );
  return body;
});

const pairingFailure = (message: string) => new SshPairingError({ message, stdout: "" });

/** The existing-server probe on native Windows: only GOAT's own managed runtime is reachable. */
export const nativeExistingServer = Effect.fn("ssh.windows.existingServer")(function* (
  target: DesktopSshEnvironmentTarget,
  kind: "app" | "managed",
  auth: Auth,
) {
  if (kind === "app") return { kind: "absent" } satisfies ExistingServerProbe;
  const state = yield* inspectWindowsRuntime(target, auth, "0.0.0");
  const selected = state.selection;
  if (selected === null) return { kind: "absent" } satisfies ExistingServerProbe;
  if (
    !state.live ||
    selected.environmentId === undefined ||
    selected.port === undefined ||
    state.signals === undefined ||
    !matchesSignals(state.signals, selected.version)
  )
    return { kind: "unusable" } satisfies ExistingServerProbe;
  return {
    kind: "live",
    environmentId: selected.environmentId,
    port: selected.port,
    version: selected.version,
  } satisfies ExistingServerProbe;
});

/** A credential from the live native runtime on `port`, only while it is still that environment. */
export const nativeExistingCredential = Effect.fn("ssh.windows.existingCredential")(function* (
  target: DesktopSshEnvironmentTarget,
  kind: "app" | "managed",
  port: number,
  request: RuntimeSessionRequest,
  auth: Auth,
  expectedEnvironmentId?: EnvironmentId,
) {
  if (kind !== "managed")
    return yield* pairingFailure(`${target.alias} has no GOAT app server GOAT can attach to.`);
  const state = yield* inspectWindowsRuntime(target, auth, "0.0.0");
  const selected = state.selection;
  if (
    !state.live ||
    selected === null ||
    selected.port !== port ||
    (expectedEnvironmentId !== undefined && selected.environmentId !== expectedEnvironmentId)
  )
    return yield* pairingFailure(`The GOAT environment on ${target.alias} changed.`);
  return yield* issueWindowsCredential(target, auth, selected, request);
});

/** The live native runtime, or nothing to act on. */
const liveSelection = (target: DesktopSshEnvironmentTarget, auth: Auth) =>
  inspectWindowsRuntime(target, auth, "0.0.0").pipe(
    Effect.map((state) => (state.live ? state.selection : null)),
  );

/** The stop script's answer from native Windows: only an idle owned runtime drains and exits. */
export const orNativeStop = (target: DesktopSshEnvironmentTarget, auth: Auth) =>
  orNativeWindows(
    target,
    auth,
    Effect.gen(function* () {
      const selection = yield* liveSelection(target, auth);
      return selection === null
        ? { stdout: "", stderr: "" }
        : yield* nativeWindowsCommand(target, auth, { op: "stop", selection });
    }),
  );

/** The server log tail from native Windows, empty when nothing runs. */
export const orNativeLog = (target: DesktopSshEnvironmentTarget, auth: Auth) =>
  orNativeWindows(
    target,
    auth,
    Effect.gen(function* () {
      const selection = yield* liveSelection(target, auth);
      return selection === null
        ? { stdout: "", stderr: "" }
        : yield* nativeWindowsCommand(target, auth, { op: "log", selection });
    }),
  );
