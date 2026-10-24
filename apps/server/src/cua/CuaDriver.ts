import * as NodeModule from "node:module";

import {
  CuaAgentBlock,
  CuaDriverMcpConfiguration,
  type ComputerUseReadiness,
  type CuaDisplayCapability,
  type CuaHostStatus,
  type HostComputerUse,
} from "@goat/contracts";
import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import {
  CUA_DRIVER_PROBED_SESSION_NAMES,
  cuaDriverHostOptions,
  cuaDriverListingEnvironment,
  withCuaDriverPrivacyEnvironment,
} from "@goat/shared/cuaDriverRelease";
import {
  isCuaDriverStartupRefusal,
  prepareCuaDriverCapabilityManifest,
} from "@goat/shared/cuaDriverManifest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaDisplay from "./CuaDisplayCapability.ts";
import * as CuaDriverInstallation from "./CuaDriverInstallation.ts";
import * as LinuxReadiness from "./LinuxReadiness.ts";
import { LinuxHelperReport } from "./linuxHelperHost/LinuxHelperReport.ts";

export class CuaDriverStartError extends Schema.TaggedError<CuaDriverStartError>()(
  "CuaDriverStartError",
  { binaryPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Failed to start Cua Driver.";
  }
}

export class CuaDriverHostError extends Schema.TaggedError<CuaDriverHostError>()(
  "CuaDriverHostError",
  {
    // "restart" is the desktop retiring its driver on purpose, such as after new grants.
    // "refused" is the driver rejecting GOAT's capability manifest or launch options at startup.
    // "display" is a start refused because this host has no screen the driver can use.
    // "install" is turning computer use on when the verified driver download failed.
    operation: Schema.Literals([
      "busy",
      "start",
      "stop",
      "exit",
      "desktop",
      "timeout",
      "restart",
      "refused",
      "display",
      "install",
    ]),
    cause: Schema.optional(Schema.Defect()),
    /** The desktop's typed reason, beside its message, when agents cannot get past it alone. */
    block: Schema.optional(CuaAgentBlock),
  },
) {
  override get message() {
    // The desktop's explanation, such as a missing macOS grant, and the display probe's reason
    // are written for users.
    if (
      (this.operation === "desktop" ||
        this.operation === "display" ||
        this.operation === "install") &&
      typeof this.cause === "string"
    )
      return this.cause;
    if (this.operation === "refused") return CUA_DRIVER_REFUSED_MESSAGE;
    return `Cua Driver host failed during ${this.operation}.`;
  }
}

export const CUA_DRIVER_REFUSED_MESSAGE =
  "Cua Driver refused GOAT's capability manifest or launch options. The server log has the driver's reason.";

export type CuaDriverError = CuaDriverStartError | CuaDriverHostError;

/** The typed reason behind a failed start, when agents cannot get past it alone (#1399). */
export const agentBlock = (failure: Option.Option<CuaDriverError>) =>
  Option.isSome(failure) && failure.value._tag === "CuaDriverHostError"
    ? failure.value.block
    : undefined;

/**
 * The block that still explains anything: once the helper's newer readiness reports every
 * missing grant granted, the last failure is history and the next start tries again (#1399).
 */
const currentBlock = (
  failure: Option.Option<CuaDriverError>,
  readiness: ComputerUseReadiness | undefined,
) => {
  const block = agentBlock(failure);
  if (block === undefined || readiness === undefined) return block;
  const granted = block.missing.every(
    (grant) =>
      readiness.grants[grant === "accessibility" ? "accessibility" : "screenCapture"] === "granted",
  );
  return granted ? undefined : block;
};

const decodeMcp = Schema.decodeEffect(CuaDriverMcpConfiguration);
const isStartError = Schema.is(CuaDriverStartError);
const isHostError = Schema.is(CuaDriverHostError);

export interface CuaDriverHost {
  readonly start: Effect.Effect<CuaDriverMcpConfiguration, CuaDriverError>;
  readonly stop: Effect.Effect<void, CuaDriverError>;
  readonly waitForExit: Effect.Effect<void, CuaDriverError>;
}

export class CuaDriver extends Context.Service<
  CuaDriver,
  {
    readonly acquire: Effect.Effect<Option.Option<CuaDriverMcpConfiguration>>;
    readonly enabled: Effect.Effect<boolean>;
    readonly lastFailure: Effect.Effect<Option.Option<CuaDriverError>>;
    /**
     * Why an agent cannot use the computer here until a person acts, from the last failure and
     * the helper's newest report only, so admission never waits on a readiness probe.
     */
    readonly block: Effect.Effect<CuaAgentBlock | undefined>;
    readonly status: Effect.Effect<CuaHostStatus>;
    readonly computerUse: Effect.Effect<HostComputerUse>;
    /**
     * Checks a request to turn computer use on: probes the screen again and fails with the
     * reason when the driver cannot run here. Already on passes, so other saves on a host whose
     * screen went away still go through; the next start reports the problem instead.
     */
    readonly admitEnable: Effect.Effect<void, CuaDriverHostError>;
    /**
     * The X display the running driver was started on (its DISPLAY and XAUTHORITY), so the lease
     * proxy can check every window the driver names is really there (#1358). None when the
     * driver is not running or has no X display.
     */
    readonly x11Display?: Effect.Effect<Option.Option<CuaX11Display>>;
    /**
     * The running driver's socket and the display environment it was started with, for the
     * server's own live frames of a Linux session (#1370). None when the driver is not running.
     */
    readonly driverSession?: Effect.Effect<
      Option.Option<{
        readonly mcp: CuaDriverMcpConfiguration;
        readonly display: ReadonlyArray<CuaDisplay.CuaDisplayVariable>;
      }>
    >;
  }
>()("goat/cua/CuaDriver") {}

export interface CuaX11Display {
  readonly DISPLAY: string;
  readonly XAUTHORITY?: string;
}

/** The X display among the variables a driver was started with. */
const x11DisplayOf = (
  environment: ReadonlyArray<CuaDisplay.CuaDisplayVariable>,
): Option.Option<CuaX11Display> => {
  const value = (name: string) => environment.find((variable) => variable.name === name)?.value;
  const display = value("DISPLAY");
  if (display === undefined || display.trim() === "") return Option.none();
  const xauthority = value("XAUTHORITY");
  return Option.some(
    xauthority === undefined ? { DISPLAY: display } : { DISPLAY: display, XAUTHORITY: xauthority },
  );
};

interface Acquisition {
  readonly result: Deferred.Deferred<Option.Option<CuaDriverMcpConfiguration>>;
  host?: CuaDriverHost;
  cleanup?: Fiber.Fiber<void>;
  watcher?: Fiber.Fiber<void> | undefined;
  revoked: boolean;
  running?: boolean;
  mcp?: CuaDriverMcpConfiguration;
  displayEnvironment?: ReadonlyArray<CuaDisplay.CuaDisplayVariable>;
  /** What this daemon last said about the macOS grants; a failed check clears it. */
  grants?: CuaDisplay.MacGrants | null;
}

/** Creates a host that runs the driver with the probed display environment. */
export type CuaDriverHostFactory = (
  display: ReadonlyArray<CuaDisplay.CuaDisplayVariable>,
) => Effect.Effect<CuaDriverHost, CuaDriverError>;

const withoutEnvironment = (probe: CuaDisplay.CuaDisplayProbe): CuaDisplayCapability => ({
  capability: probe.capability,
  reason: probe.reason,
  ...(probe.display === undefined ? {} : { display: probe.display }),
});

export interface CuaDriverOptions {
  readonly observeReadiness?: (
    mcp: CuaDriverMcpConfiguration,
    display: ReadonlyArray<CuaDisplay.CuaDisplayVariable>,
  ) => Effect.Effect<Pick<CuaHostStatus, "readiness" | "signals"> | undefined>;
  /** The verified install, run when computer use is turned on; absent where the driver ships. */
  readonly install?: Effect.Effect<void, CuaDriverHostError>;
  /** The running daemon's own view of the macOS grants; null when it does not say. */
  readonly observeGrants?: (
    mcp: CuaDriverMcpConfiguration,
  ) => Effect.Effect<CuaDisplay.MacGrants | null>;
  /**
   * What the host's computer use helper last reported: its readiness steps and the safety
   * signals it raises. The desktop host's helper reports through desktop telemetry; a server
   * that runs its own helper (Linux, #1223) passes that helper's answer here.
   */
  readonly helperReadiness?: Effect.Effect<
    Option.Option<Pick<CuaHostStatus, "readiness" | "signals">>
  >;
}

export const make = Effect.fn("CuaDriver.make")(function* (
  factory: CuaDriverHostFactory,
  probe: Effect.Effect<CuaDisplay.CuaDisplayProbe>,
  options: CuaDriverOptions = {},
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const changes = yield* settings.subscribeChanges;
  // Status is read on every focus and host-status fan-out; starts and enables probe fresh.
  const [cachedProbe, invalidateProbe] = yield* Effect.cachedInvalidateWithTTL(probe, "10 seconds");
  const freshProbe = invalidateProbe.pipe(Effect.andThen(cachedProbe));
  let active: Acquisition | undefined;
  let closed = false;
  let failure = Option.none<CuaDriverError>();
  // Only the running daemon's latest answer counts: a grant can be revoked between checks or
  // runs, and a check that fails or times out cannot vouch for the grants it last saw.
  const observeGrants = Effect.suspend(() => {
    const entry = active;
    if (!options.observeGrants || !entry?.running || !entry.mcp) return Effect.void;
    return options.observeGrants(entry.mcp).pipe(
      Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.succeed(null) }),
      Effect.tap((observed) =>
        Effect.sync(() => {
          entry.grants = observed;
        }),
      ),
      Effect.asVoid,
    );
  });
  const [cachedGrants, invalidateGrants] = yield* Effect.cachedInvalidateWithTTL(
    observeGrants,
    "10 seconds",
  );

  const stop = Effect.fnUntraced(function* (entry: Acquisition) {
    if (entry.watcher) yield* Fiber.interrupt(entry.watcher).pipe(Effect.forkDetach);
    if (!entry.cleanup && entry.host) {
      entry.cleanup = yield* entry.host.stop.pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (active === entry || active === undefined) failure = Option.some(error);
          }),
        ),
        Effect.ignoreCause({ log: true }),
        Effect.forkDetach({ startImmediately: true }),
      );
    }
    if (entry.cleanup) yield* Fiber.join(entry.cleanup).pipe(Effect.timeoutOption("4 seconds"));
  });

  const revoke = Effect.fnUntraced(function* (entry: Acquisition) {
    entry.revoked = true;
    entry.running = false;
    if (active === entry) active = undefined;
    yield* Deferred.succeed(entry.result, Option.none());
    yield* stop(entry);
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      if (active) yield* revoke(active);
    }),
  );
  yield* changes.pipe(
    Stream.runForEach((value) =>
      Effect.gen(function* () {
        if (!value.enableCua && active) yield* revoke(active);
      }),
    ),
    Effect.forkScoped,
  );

  const start = Effect.fnUntraced(
    function* (entry: Acquisition) {
      if (entry.revoked) return;
      // The screen can go away after the last check, such as a desktop session signing out.
      const display = yield* freshProbe;
      if (display.capability === "unavailable")
        return yield* new CuaDriverHostError({ operation: "display", cause: display.reason });
      if (entry.revoked) return;
      entry.displayEnvironment = display.environment;
      entry.host = yield* factory(display.environment);
      if (entry.revoked) {
        yield* stop(entry);
        return;
      }
      const mcp = yield* entry.host.start.pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(new CuaDriverHostError({ operation: "timeout" })),
        }),
      );
      if (entry.revoked) return;
      failure = Option.none();
      entry.running = true;
      entry.mcp = mcp;
      yield* invalidateGrants;
      yield* cachedGrants.pipe(Effect.forkDetach);
      yield* Deferred.succeed(entry.result, Option.some(withCuaDriverPrivacyEnvironment(mcp)));
      entry.watcher = yield* entry.host.waitForExit.pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => new CuaDriverHostError({ operation: "exit" }),
        }),
        Effect.flatMap((error) =>
          Effect.gen(function* () {
            if (active !== entry) return;
            failure =
              isHostError(error) && error.operation === "restart"
                ? Option.none()
                : Option.some(error);
            // The watcher must not interrupt itself while retiring its host.
            entry.watcher = undefined;
            yield* revoke(entry);
          }),
        ),
        Effect.forkDetach,
      );
    },
    (effect, entry) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (active !== entry) return;
            failure = Option.some(
              Option.getOrElse(
                Cause.findErrorOption(cause),
                () => new CuaDriverHostError({ operation: "start", cause: Cause.squash(cause) }),
              ),
            );
            yield* stop(entry);
            yield* revoke(entry);
          }),
        ),
      ),
  );

  const enabled = settings.getSettings.pipe(
    Effect.map((value) => !closed && value.enableCua),
    Effect.catch((cause) =>
      Effect.sync(() => {
        failure = Option.some(new CuaDriverHostError({ operation: "start", cause }));
        return false;
      }),
    ),
  );
  const acquire = Effect.gen(function* () {
    if (!(yield* enabled)) {
      if (active) yield* revoke(active);
      return Option.none<CuaDriverMcpConfiguration>();
    }
    let entry = active;
    if (!entry) {
      entry = {
        result: yield* Deferred.make<Option.Option<CuaDriverMcpConfiguration>>(),
        revoked: false,
      };
      active = entry;
      yield* start(entry).pipe(Effect.forkDetach);
    }
    return yield* Deferred.await(entry.result);
  });
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  const running = () => active?.running === true;
  // Status reads wait for a grant check already in flight, and re-check every ten seconds.
  const reported = Effect.all([cachedProbe, cachedGrants]).pipe(
    Effect.map(([display]) =>
      CuaDisplay.withMacGrants(
        withoutEnvironment(display),
        active?.running ? (active.grants ?? null) : null,
      ),
    ),
  );
  return CuaDriver.of({
    acquire,
    x11Display: Effect.sync(() =>
      active?.running && active.displayEnvironment !== undefined
        ? x11DisplayOf(active.displayEnvironment)
        : Option.none(),
    ),
    driverSession: Effect.sync(() =>
      active?.running && active.mcp !== undefined && active.displayEnvironment !== undefined
        ? Option.some({ mcp: active.mcp, display: active.displayEnvironment })
        : Option.none(),
    ),
    enabled,
    lastFailure: Effect.sync(() => failure),
    block: (options.helperReadiness ?? Effect.succeedNone).pipe(
      Effect.map((helper) =>
        currentBlock(failure, Option.isSome(helper) ? helper.value.readiness : undefined),
      ),
    ),
    status: Effect.gen(function* () {
      const display = yield* reported;
      // The helper's own report (desktop telemetry) wins; the server-run Linux helper is read
      // only when nothing reported.
      const reportedByHelper = options.helperReadiness ?? Effect.succeedNone;
      const first = yield* reportedByHelper;
      const entry = active;
      const observe =
        Option.isNone(first) && entry?.running && entry.mcp ? options.observeReadiness : undefined;
      const observed =
        observe && entry?.mcp
          ? yield* observe(entry.mcp, entry.displayEnvironment ?? []).pipe(
              Effect.timeoutOrElse({
                duration: "15 seconds",
                orElse: () => Effect.succeed(undefined),
              }),
            )
          : undefined;
      // A report that arrived while the Linux helper was read is newer, so it still wins, even
      // when that read failed or timed out.
      const helper = observe ? yield* reportedByHelper : first;
      const isEnabled = yield* enabled;
      const block = currentBlock(
        failure,
        Option.isSome(helper) ? helper.value.readiness : observed?.readiness,
      );
      return {
        platform:
          platform === "darwin" || platform === "linux" || platform === "win32"
            ? platform
            : ("other" as const),
        running: running(),
        tools: !isEnabled ? "off" : running() ? "available" : "unavailable",
        ...(isEnabled && entry === active && entry?.running && observed && Option.isNone(helper)
          ? observed
          : {}),
        ...(Option.isSome(failure) ? { failure: failure.value.message } : {}),
        ...(block === undefined ? {} : { block }),
        ...(platform === "linux"
          ? { wayland: hostEnvironment.XDG_SESSION_TYPE?.toLowerCase() === "wayland" }
          : {}),
        display,
        ...(Option.isSome(helper) ? helper.value : {}),
      } satisfies CuaHostStatus;
    }),
    computerUse: Effect.all([enabled, reported]).pipe(
      Effect.map(([isEnabled, display]) => ({
        enabled: isEnabled,
        running: running(),
        ...display,
      })),
    ),
    admitEnable: Effect.gen(function* () {
      if (yield* enabled) return;
      const display = yield* freshProbe;
      if (display.capability === "unavailable")
        return yield* new CuaDriverHostError({ operation: "display", cause: display.reason });
      // Turning it on means the driver is here and verified; only the daemon start waits.
      if (options.install) yield* options.install;
    }),
  });
});

type NativeModule = {
  readonly EmbeddedCuaDriverHost: {
    readonly withOptions: (
      options: ReturnType<typeof cuaDriverHostOptions>,
    ) => Pick<EmbeddedCuaDriverHost, "start" | "stop" | "waitForExit" | "uniffiDestroy">;
  };
};

// Standalone servers have no application bundle. The driver echoes this id in its daemon
// metadata, and the SDK refuses a daemon that reports a different one.
const STANDALONE_HOST_BUNDLE_ID = "si.goat.server";

// SEA can load file-backed SDKs through require. This SDK only exports import
// conditions, so resolve its package directory and require the entry file directly.
const requireForCuaDriver = NodeModule.createRequire(import.meta.url);

type SdkClientModule = {
  readonly CuaDriver: {
    readonly connect: (socketPath: string) => {
      readonly callTool: (
        name: string,
        argumentsJson: string,
      ) => Promise<{ readonly isError: boolean; readonly structuredJson?: string }>;
      readonly uniffiDestroy?: () => void;
    };
  };
};

/** Asks the running daemon, which is the process macOS grants, for its own permissions. */
const makeMacGrantObserver = Effect.fn("CuaDriver.makeMacGrantObserver")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (mcp: CuaDriverMcpConfiguration) =>
    Effect.gen(function* () {
      const socketPath = mcp.socketPath;
      if (!socketPath) return null;
      for (const lookup of requireForCuaDriver.resolve.paths("@trycua/cua-driver") ?? []) {
        const directory = path.join(lookup, "@trycua", "cua-driver");
        if (!(yield* fs.exists(path.join(directory, "package.json")))) continue;
        const sdk = yield* Effect.try(
          () => requireForCuaDriver(path.join(directory, "dist", "index.js")) as SdkClientModule,
        );
        return yield* Effect.tryPromise(async () => {
          const client = sdk.CuaDriver.connect(socketPath);
          try {
            const result = await client.callTool("check_permissions", "{}");
            return result.isError ? null : CuaDisplay.parseMacGrants(result.structuredJson);
          } finally {
            client.uniffiDestroy?.();
          }
        });
      }
      return null;
    }).pipe(Effect.orElseSucceed(() => null));
});

export const makeStandaloneHostFactory = Effect.fn("CuaDriver.makeStandaloneHostFactory")(
  function* <E, M, P>(
    executable: Effect.Effect<string, E>,
    /** Writes the capability manifest for this binary and returns its path. */
    prepareManifest: (binaryPath: string) => Effect.Effect<string, P>,
    module?: Effect.Effect<NativeModule, M>,
  ) {
    const environment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let owned = false;
    return (display: ReadonlyArray<CuaDisplay.CuaDisplayVariable>) =>
      Effect.gen(function* () {
        if (owned) return yield* new CuaDriverHostError({ operation: "busy" });
        const binaryPath =
          environment.GOAT_CUA_DRIVER_PATH?.trim() ||
          (yield* executable.pipe(
            Effect.mapError((cause) => new CuaDriverHostError({ operation: "start", cause })),
          ));
        const sdk = yield* module === undefined
          ? Effect.gen(function* () {
              for (const lookup of requireForCuaDriver.resolve.paths("@trycua/cua-driver") ?? []) {
                const directory = path.join(lookup, "@trycua", "cua-driver");
                if (yield* fs.exists(path.join(directory, "package.json"))) {
                  return yield* Effect.try({
                    try: () =>
                      requireForCuaDriver(
                        path.join(directory, "dist", "embedded.js"),
                      ) as NativeModule,
                    catch: (cause) => new CuaDriverStartError({ binaryPath, cause }),
                  });
                }
              }
              return yield* new CuaDriverStartError({
                binaryPath,
                cause: "@trycua/cua-driver is not installed beside this server.",
              });
            }).pipe(
              Effect.mapError((cause) =>
                isStartError(cause) ? cause : new CuaDriverStartError({ binaryPath, cause }),
              ),
            )
          : module.pipe(Effect.mapError((cause) => new CuaDriverStartError({ binaryPath, cause })));
        // Acquisition can suspend during installation/loading, so check ownership again.
        if (owned) return yield* new CuaDriverHostError({ operation: "busy" });
        const manifestPath = yield* prepareManifest(binaryPath).pipe(
          Effect.mapError((cause) => new CuaDriverStartError({ binaryPath, cause })),
        );
        if (owned) return yield* new CuaDriverHostError({ operation: "busy" });
        const native = yield* Effect.try({
          try: () =>
            sdk.EmbeddedCuaDriverHost.withOptions(
              cuaDriverHostOptions(
                binaryPath,
                STANDALONE_HOST_BUNDLE_ID,
                manifestPath,
                display,
                platform === "linux" ? CUA_DRIVER_PROBED_SESSION_NAMES : [],
              ),
            ),
          catch: (cause) => new CuaDriverStartError({ binaryPath, cause }),
        });
        owned = true;
        let starting: Promise<EmbeddedDriverConnection> | undefined;
        let stopping: Promise<void> | undefined;
        const watchers = new Map<AbortController, Promise<unknown>>();

        const start = Effect.tryPromise({
          try: () => {
            if (stopping) return Promise.reject(new CuaDriverHostError({ operation: "start" }));
            starting ??= native.start();
            return starting;
          },
          catch: (cause) =>
            isCuaDriverStartupRefusal(cause)
              ? new CuaDriverHostError({ operation: "refused", cause })
              : new CuaDriverStartError({ binaryPath, cause }),
        }).pipe(
          Effect.flatMap((connection) =>
            decodeMcp({
              ...connection.mcp,
              socketPath: connection.socketPath,
            }),
          ),
          Effect.mapError((cause) =>
            isStartError(cause) || isHostError(cause)
              ? cause
              : new CuaDriverStartError({ binaryPath, cause }),
          ),
        );

        const stop = Effect.tryPromise({
          try: () =>
            (stopping ??= (async () => {
              // UniFFI cancellation ends the JS wait before native work necessarily settles.
              // Retain the owner until every owned operation has settled, even after public shutdown.
              await starting?.catch(() => undefined);
              for (const controller of watchers.keys()) controller.abort();
              await Promise.allSettled(watchers.values());
              try {
                await native.stop();
              } finally {
                owned = false;
                native.uniffiDestroy();
              }
            })()),
          catch: (cause) => new CuaDriverHostError({ operation: "stop", cause }),
        });
        const waitForExit = Effect.tryPromise({
          try: async (signal) => {
            const connection = await starting;
            if (!connection || stopping) return;
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) controller.abort();
            const waiting = native.waitForExit(connection.generation, {
              signal: controller.signal,
            });
            watchers.set(controller, waiting);
            try {
              await waiting;
            } finally {
              watchers.delete(controller);
              signal.removeEventListener("abort", abort);
            }
          },
          catch: (cause) => new CuaDriverHostError({ operation: "exit", cause }),
        });
        return { start, stop, waitForExit } satisfies CuaDriverHost;
      });
  },
);

/** The desktop host's helper readiness, as desktop telemetry last carried it. */
const desktopHelperReadiness = Effect.map(
  DesktopTelemetryReceiver.DesktopTelemetryReceiver,
  (receiver) =>
    receiver.cuaReadiness.pipe(
      Effect.map(Option.map(({ readiness, signals }) => ({ readiness, signals }))),
    ),
);

export const makeDesktopHostFactory = Effect.fn("CuaDriver.makeDesktopHostFactory")(function* () {
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const crypto = yield* Crypto.Crypto;
  // The desktop app runs in the signed-in session and starts the driver with its own environment.
  return (_display: ReadonlyArray<CuaDisplay.CuaDisplayVariable>) =>
    Effect.gen(function* () {
      const requestId = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError((cause) => new CuaDriverHostError({ operation: "desktop", cause })));
      const scope = yield* Scope.make();
      const ready = yield* Deferred.make<CuaDriverMcpConfiguration, CuaDriverError>();
      const stopped = yield* Deferred.make<void, CuaDriverError>();
      let requested = false;
      let retired = false;
      const unavailable = new CuaDriverHostError({ operation: "desktop" });
      const retire = (error: CuaDriverError) =>
        Deferred.fail(ready, error).pipe(Effect.andThen(Deferred.fail(stopped, error)));
      const lost = Deferred.fail(ready, unavailable).pipe(
        Effect.andThen(Deferred.succeed(stopped, undefined)),
      );
      const start = Effect.gen(function* () {
        // Start the subscription before writing: the desktop may reply synchronously.
        yield* receiver.cuaReports.pipe(
          Stream.runForEach((report) =>
            Effect.gen(function* () {
              if (report.requestId !== requestId) return;
              if (report.status === "ready") yield* Deferred.succeed(ready, report.mcp);
              else if (report.status === "stopped")
                yield* retire(new CuaDriverHostError({ operation: "restart" }));
              else
                yield* retire(
                  report.message === undefined && report.block === undefined
                    ? unavailable
                    : new CuaDriverHostError({
                        operation: "desktop",
                        ...(report.message === undefined ? {} : { cause: report.message }),
                        ...(report.block === undefined ? {} : { block: report.block }),
                      }),
                );
            }),
          ),
          Effect.ensuring(lost),
          Effect.forkIn(scope, { startImmediately: true }),
        );
        const health = yield* receiver.subscribeHealth.pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        if (health.latest.status === "unavailable" || health.latest.status === "stopped")
          return yield* unavailable;
        yield* health.changes.pipe(
          Stream.runForEach((value) =>
            value.status === "stopped" || value.status === "unavailable" ? lost : Effect.void,
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        );
        if (retired) return yield* unavailable;
        requested = true;
        yield* receiver
          .requestCuaDriver(requestId, true)
          .pipe(
            Effect.mapError((cause) => new CuaDriverHostError({ operation: "desktop", cause })),
          );
        return yield* Deferred.await(ready);
      });
      const stop = Effect.gen(function* () {
        retired = true;
        if (!requested) return;
        yield* receiver
          .requestCuaDriver(requestId, false)
          .pipe(
            Effect.mapError((cause) => new CuaDriverHostError({ operation: "desktop", cause })),
          );
        yield* Deferred.await(stopped).pipe(Effect.ignore, Effect.timeoutOption("3 seconds"));
      }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
      return { start, stop, waitForExit: Deferred.await(stopped) } satisfies CuaDriverHost;
    });
});

export const layer = Layer.effect(
  CuaDriver,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const platform = yield* HostProcess.Platform;
    const environment = yield* HostProcess.Environment;
    const { factory, install, helperReadiness } =
      config.mode === "desktop"
        ? // The desktop app ships its driver, so there is nothing to install.
          {
            factory: yield* makeDesktopHostFactory(),
            install: undefined,
            helperReadiness: yield* desktopHelperReadiness,
          }
        : yield* Effect.gen(function* () {
            const installation = yield* CuaDriverInstallation.makeCuaDriverInstallation({
              baseDir: config.baseDir,
            });
            const path = yield* Path.Path;
            const factory = yield* makeStandaloneHostFactory(
              installation.executable,
              (binaryPath) =>
                Effect.tryPromise(() =>
                  prepareCuaDriverCapabilityManifest({
                    binaryPath,
                    platform,
                    environment: cuaDriverListingEnvironment(environment),
                    hostBundleIds: [STANDALONE_HOST_BUNDLE_ID],
                    path: path.join(config.stateDir, "cua-driver", "capability-manifest.yaml"),
                  }),
                ),
            );
            const install = environment.GOAT_CUA_DRIVER_PATH?.trim()
              ? undefined
              : installation.executable.pipe(
                  Effect.asVoid,
                  Effect.mapError(
                    (error) =>
                      new CuaDriverHostError({ operation: "install", cause: error.message }),
                  ),
                );
            // A Linux server runs its own helper (#1223); its report stands in for the desktop's.
            const linuxHelper =
              platform === "linux" ? yield* Effect.serviceOption(LinuxHelperReport) : Option.none();
            const helperReadiness = Option.isSome(linuxHelper)
              ? Ref.get(linuxHelper.value.latest).pipe(
                  Effect.map(Option.map(({ readiness, signals }) => ({ readiness, signals }))),
                )
              : undefined;
            return { factory, install, helperReadiness };
          });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const probe = CuaDisplay.probeDisplay(
      config.mode === "desktop" ? "desktop" : "standalone",
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return yield* make(factory, probe, {
      ...(install ? { install } : {}),
      ...(helperReadiness ? { helperReadiness } : {}),
      ...(platform === "darwin" ? { observeGrants: yield* makeMacGrantObserver() } : {}),
      ...(platform === "linux" ? { observeReadiness: yield* LinuxReadiness.makeObserver() } : {}),
    });
  }),
);
