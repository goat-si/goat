import {
  CuaDriverMcpConfiguration,
  type CuaVerificationStep,
  type CuaVerificationStepId,
  type DesktopCuaDriverRequest,
  type DesktopCuaGrants,
  type DesktopCuaVerification,
} from "@goat/contracts";
import { cuaRequestableApps, isCuaDriverStartupRefusal } from "@goat/shared/cuaDriverManifest";
import {
  COMPUTER_USE_HELPER_NAME,
  computerUseHelperBundleId,
  cuaDriverHostOptions,
  cuaDriverListingEnvironment,
  cuaDriverRelease,
} from "@goat/shared/cuaDriverRelease";
import type { EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { cuaGrantTarget, readCuaGrants, type CuaGrantTarget } from "./DesktopCuaGrants.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import {
  helperSignals,
  initialHelperReadiness,
  toReadiness,
  withGrants,
  withProof,
  withRunning,
  withoutProof,
  type HelperProof,
  type HelperReadinessState,
} from "./helperReadiness.ts";
import { ComputerUseHelperError, helperBundle } from "./ComputerUseHelper.ts";
import { cuaDriverReports } from "./desktopCuaReports.ts";
import { makeHelperFollowers } from "./helperFollowers.ts";
import { withResolvedWindowsPaths } from "./windowsHostPaths.ts";
import { refreshDesktopManifest } from "./DesktopCuaManifest.ts";
import {
  describeDegraded,
  failedCall,
  identityFailure,
  permissionsFailure,
  readArray,
  readNumber,
  readString,
  type ToolCall,
} from "./driverChecks.ts";
import { windowsHelperBundle, windowsPermissionsFailure } from "./ComputerUseHelperWindows.ts";
import {
  dependencies,
  type DesktopCuaDriverDependencies,
  type NativeHost,
  type Grants,
  type Engine,
  type CuaManifestScope,
} from "./DesktopCuaNative.ts";
export {
  bitmapHasContent,
  type DesktopCuaDriverDependencies,
  type CuaManifestScope,
} from "./DesktopCuaNative.ts";

interface OwnedHost {
  readonly host: NativeHost;
  readonly abort: AbortController;
  readonly started: Promise<EmbeddedDriverConnection>;
  /** Run by GOAT Computer Use; only such a host makes the helper's readiness "running". */
  readonly helper: boolean;
  readonly direct: boolean;
  readonly refreshManifest: (
    apps: ReadonlyArray<string>,
  ) => ReturnType<typeof refreshDesktopManifest>;
  /** It exited before GOAT stopped it; retire aborts before stopping, so its own stop never is. */
  crashed?: boolean;
  monitor?: Promise<void>;
  cleanup?: Promise<void>;
}

export class DesktopCuaDriver extends Context.Service<
  DesktopCuaDriver,
  {
    readonly listen: Effect.Effect<void, never, import("effect/Scope").Scope>;
    readonly restart: Effect.Effect<void>;
    readonly verify: Effect.Effect<DesktopCuaVerification>;
    readonly grantTarget: Effect.Effect<CuaGrantTarget>;
    /** The target's grants without prompting; each call asks a fresh helper process. */
    readonly grants: Effect.Effect<DesktopCuaGrants, ComputerUseHelperError>;
  }
>()("@goat/desktop/cua/DesktopCuaDriver") {}

const decodeMcp = Schema.decodeEffect(CuaDriverMcpConfiguration);
const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

const VERIFICATION_STEPS = 6;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("desktop.cua.make")(function* (
  native: DesktopCuaDriverDependencies = dependencies,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const mutex = yield* Semaphore.make(1);
  const crashes = yield* Queue.unbounded<OwnedHost>();
  let owned: OwnedHost | undefined;
  let currentRequest: DesktopCuaDriverRequest | undefined;
  let closed = false;
  // The server learns the helper's readiness from these reports; only a helper build sends them.
  let helperState = initialHelperReadiness;
  let helperGeneration = 0;
  let helperSeen = false;
  let lastReadiness: string | undefined;
  let watches = 0;
  // What the running helper said it can do; a build without a method raises nothing for it.
  let helperCanWatch = false;
  // Whether the running helper's agent connections report a person's input.
  let helperReportsInput = false;
  let helperCanFrame = false;
  /**
   * What a helper said it can do when it started, read from its hello: an agent turn's start and a
   * readiness check's both start one (#1532), and either is the build that runs next.
   */
  const learnHelper = (
    session:
      | {
          readonly canWatch?: boolean;
          readonly reportsInput?: boolean;
          readonly canFrame?: boolean;
        }
      | undefined,
  ) => {
    helperCanWatch = session?.canWatch === true;
    // Only macOS agents run through a connection helper that sees a person's input.
    helperReportsInput = environment.platform === "darwin" && session?.reportsInput === true;
    helperCanFrame = session?.canFrame === true;
  };
  const followers = yield* makeHelperFollowers({
    publisher,
    newWatchId: () => "watch-" + helperGeneration + "-" + ++watches,
  });
  /** Whether the running check reads through the helper; only then do its reads prove anything. */
  let checkingHelper = false;
  const noteHelper = (update: (state: HelperReadinessState) => HelperReadinessState) =>
    Effect.suspend(() => {
      if (!helperSeen || closed) return Effect.void;
      helperState = update(helperState);
      const report = {
        version: 1,
        type: "cuaReadiness",
        generation: helperGeneration,
        readiness: toReadiness(helperState, COMPUTER_USE_HELPER_NAME),
        signals: helperSignals(helperCanWatch, helperReportsInput),
        frames: helperCanFrame,
      } as const;
      const key = encodeJson(report);
      if (key === lastReadiness) return Effect.void;
      lastReadiness = key;
      return publisher.publishCuaReadiness(report);
    });
  const noteChecked = (update: (state: HelperReadinessState) => HelperReadinessState) =>
    Effect.suspend(() => (checkingHelper ? noteHelper(update) : Effect.void));
  /**
   * The helper seen before is gone, unusable, or not chosen: what it proved then says nothing
   * now, and nothing runs as it.
   */
  const forgetHelper = (chosen: Engine | string | undefined) =>
    Effect.sync(() => learnHelper(undefined)).pipe(
      Effect.andThen(
        noteHelper((state) =>
          withoutProof(
            withRunning(state, false),
            typeof chosen === "string" ? chosen : `${COMPUTER_USE_HELPER_NAME} could not be found.`,
          ),
        ),
      ),
    );
  const forgetCrash = (entry: OwnedHost) =>
    Effect.suspend(() => {
      if (!entry.helper || !entry.crashed) return Effect.void;
      // Consume it once, before a retiring host can be replaced or a new check proves it again.
      entry.crashed = false;
      return noteHelper((state) =>
        withoutProof(
          state,
          `${COMPUTER_USE_HELPER_NAME} stopped unexpectedly. Run the readiness check again.`,
        ),
      );
    });

  // UniFFI calls can outlive cancellation. Retain the host until every native
  // promise settles, even after the public shutdown deadline has elapsed.
  const retire = (entry: OwnedHost): Promise<void> => {
    if (!entry.cleanup) {
      entry.cleanup = (async () => {
        await settle(entry.started);
        entry.abort.abort();
        await settle(Promise.resolve().then(() => entry.host.stop()));
        if (entry.monitor) await entry.monitor;
        entry.host.uniffiDestroy();
        if (owned === entry) owned = undefined;
      })();
    }
    return entry.cleanup;
  };
  const stop = Effect.suspend(() => {
    const entry = owned;
    return entry
      ? Effect.tryPromise(() => retire(entry)).pipe(
          Effect.timeoutOption("2 seconds"),
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => false),
          Effect.tap(() => forgetCrash(entry)),
        )
      : Effect.succeed(true);
  }).pipe(
    Effect.tap(() => noteHelper((state) => withRunning(state, false))),
    Effect.tap(() => followers.detach),
  );
  const { report, unavailable, ungranted, desktopUnavailable } = cuaDriverReports(
    publisher,
    () => closed,
  );

  const restartHost = Effect.gen(function* () {
    const request = owned ? currentRequest : undefined;
    currentRequest = undefined;
    const stopped = yield* stop;
    if (request)
      yield* stopped ? report(request.requestId, "stopped") : unavailable(request.requestId);
  });
  const restart = mutex.withPermits(1)(restartHost);

  const driverPath = () =>
    environment.isPackaged
      ? environment.platform === "darwin"
        ? environment.path.join(environment.resourcesPath, "cua-driver")
        : environment.path.join(
            environment.resourcesPath,
            "cua-driver",
            environment.platform === "win32" ? "cua-driver.exe" : "cua-driver",
          )
      : process.env.GOAT_CUA_DRIVER_PATH?.trim();

  /**
   * A Mac or Windows build that ships the helper always uses it. Only a build without one runs
   * the driver in-process under GOAT's own identity; a helper that is there and unusable is a
   * reason string, and computer use stays off.
   */
  const engine = Effect.fn("desktop.cua.engine")(function* () {
    if (environment.platform === "darwin" || environment.platform === "win32") {
      const bundleId = computerUseHelperBundleId(environment.appUserModelId);
      const found = yield* Effect.tryPromise(() =>
        native.helperBundlePath({
          isPackaged: environment.isPackaged,
          resourcesPath: environment.resourcesPath,
          platform: environment.platform,
          stateDir: environment.stateDir,
          bundleId,
          // The installed helper switches generations only while none runs (#1162).
          busy: owned !== undefined,
        }),
      ).pipe(
        Effect.orElseSucceed(
          () =>
            ({
              kind: "unusable",
              message: `${COMPUTER_USE_HELPER_NAME} could not be found.`,
            }) as const,
        ),
      );
      if (found.kind === "unusable") return found.message;
      if (found.kind === "found") {
        if (found.note) yield* Effect.logWarning(found.note);
        return {
          kind: "helper",
          bundle:
            environment.platform === "win32"
              ? windowsHelperBundle(found.path, bundleId)
              : helperBundle(found.path, bundleId),
        } satisfies Engine;
      }
    }
    const path = driverPath();
    return path ? ({ kind: "embedded", driverPath: path } satisfies Engine) : undefined;
  });
  const enginePath = (engine: Engine) =>
    engine.kind === "helper" ? engine.bundle.driverPath : engine.driverPath;
  /** The bundle id the driver must report as its parent application. */
  const engineBundleId = (engine: Engine) =>
    engine.kind === "helper" ? engine.bundle.bundleId : environment.appUserModelId;
  const engineGrants = (engine: Engine, prompt: boolean): Promise<Grants> =>
    engine.kind === "helper"
      ? native.helperGrants(engine.bundle, prompt, environment.platform)
      : prompt
        ? native.loadElectron().then((electron) => {
            const granted = electron.hasRequiredMacOSPermissions(
              electron.requestMacOSPermissions(),
            );
            return { accessibility: granted, screenRecording: granted };
          })
        : native.checkGrants();

  // An unpackaged Electron on macOS runs under Electron's own bundle id. Agents never get GOAT
  // or its helper as a target; the grant check reads GOAT's own window.
  const hostBundleIds = (engine: Engine) => [
    environment.appUserModelId,
    ...(environment.isPackaged ? [] : ["com.github.Electron"]),
    ...(environment.platform === "win32" ? [native.executablePath] : []),
    ...(engine.kind === "helper" ? [engine.bundle.bundleId] : []),
  ];

  // Both request-time listings and manifest refreshes must stay inside the helper's seal check.
  const helperListing = (engine: Engine) =>
    engine.kind === "helper" &&
    (environment.platform === "darwin" || environment.platform === "win32")
      ? () => native.helperApps(engine.bundle, environment.platform)
      : undefined;

  const handleAppsRequest = Effect.fn("desktop.cua.appsRequest")(function* () {
    const batch = yield* publisher.takeCuaAppsRequests;
    if (batch.requestIds.length === 0) return;
    const apps = yield* Effect.gen(function* () {
      if (
        closed ||
        !(yield* Effect.tryPromise(() => native.computerUseEnabled(environment.serverSettingsPath)))
      )
        return undefined;
      const selected = yield* engine();
      if (typeof selected !== "object") return undefined;
      const listed = yield* Effect.tryPromise(
        () =>
          helperListing(selected)?.() ??
          native.listApps({
            binaryPath: enginePath(selected),
            platform: environment.platform,
            environment: cuaDriverListingEnvironment(process.env),
          }),
      );
      const hosts = yield* Effect.tryPromise(() =>
        withResolvedWindowsPaths(hostBundleIds(selected), environment.platform),
      );
      if (
        closed ||
        !(yield* Effect.tryPromise(() => native.computerUseEnabled(environment.serverSettingsPath)))
      )
        return undefined;
      const apps = cuaRequestableApps(listed, hosts);
      // A partial list could wrongly reject a real app, so an oversized answer is unavailable.
      return apps.length <= 1000 ? apps : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (!closed)
      for (const requestId of batch.requestIds)
        yield* batch.publish({
          version: 1,
          type: "cuaApps",
          requestId,
          ...(apps === undefined
            ? { status: "unavailable" as const }
            : { status: "listed" as const, apps }),
        });
  });

  const spawn = Effect.fn("desktop.cua.spawn")(function* (engine: Engine, scope: CuaManifestScope) {
    // Which app macOS charges the grants to, so a log shows who held them.
    yield* Effect.logInfo("Starting Cua Driver", {
      scope,
      principal: engine.kind === "helper" ? engine.bundle.bundleId : environment.appUserModelId,
    });
    const listApplications = helperListing(engine);
    const manifestInput = {
      binaryPath: enginePath(engine),
      scope,
      hostBundleIds: hostBundleIds(engine),
      directory: environment.path.join(environment.stateDir, "cua-driver"),
      platform: environment.platform,
      // The helper verifies its driver before running it, so it lists the apps too; running
      // the driver here would execute it unchecked, under GOAT's identity (#1241).
      ...(listApplications === undefined ? {} : { listApplications }),
    };
    const manifestPath = yield* Effect.tryPromise(() => native.prepareManifest(manifestInput));
    if (closed) return undefined;
    let host: NativeHost;
    if (engine.kind === "helper") {
      helperSeen = true;
      helperGeneration += 1;
      const { environment: driverEnvironment } = cuaDriverHostOptions(
        engine.bundle.driverPath,
        engine.bundle.bundleId,
        manifestPath,
      );
      host = native.helperHost({
        bundle: engine.bundle,
        driverVersion: cuaDriverRelease("darwin", "arm64")?.version ?? "",
        capabilityManifestPath: manifestPath,
        environment: driverEnvironment,
        platform: environment.platform,
        // macOS always uses a direct helper MCP pair; readiness owns its own stdio peer.
        direct: environment.platform === "darwin",
        verify: scope === "verify" && environment.platform === "darwin",
      });
    } else {
      const sdk = yield* Effect.tryPromise(() => native.loadEmbedded());
      // Scope closure may have happened while the lazy module was loading.
      if (closed) return undefined;
      host = yield* Effect.try(() =>
        sdk.EmbeddedCuaDriverHost.withOptions(
          cuaDriverHostOptions(engine.driverPath, environment.appUserModelId, manifestPath),
        ),
      );
    }
    const entry: OwnedHost = {
      host,
      abort: new AbortController(),
      started: Promise.resolve().then(() => host.start()),
      helper: engine.kind === "helper",
      direct: engine.kind === "helper" && environment.platform === "darwin",
      refreshManifest: (apps) =>
        scope === "agents"
          ? refreshDesktopManifest({
              apps,
              path: manifestPath,
              read: native.readManifest,
              prepare: () => native.prepareManifest(manifestInput),
            })
          : Effect.succeed(false),
    };
    owned = entry;
    void entry.started.then(
      (connection) => {
        entry.monitor = settle(
          Promise.resolve().then(() =>
            host.waitForExit(connection.generation, { signal: entry.abort.signal }).finally(() => {
              // Judged on the exit itself: wrapping hops would let a retire's abort land first.
              if (!entry.abort.signal.aborted) entry.crashed = true;
            }),
          ),
        ).then(() => {
          // A crash is still reported when retiring began meanwhile, so its lost proof is.
          if ((!entry.cleanup || entry.crashed) && !closed) Queue.offerUnsafe(crashes, entry);
        });
      },
      () => undefined,
    );
    return entry;
  });

  // check_permissions only reports booleans, so the grants count as working once the
  // restarted driver also reads a GOAT window's accessibility tree and captures its pixels.
  /** The generation the running check spawned; serialized by the mutex. */
  let checkHost: OwnedHost | undefined;
  const checkServicePid = () => checkHost?.host.servicePid?.();
  const verify = Effect.gen(function* () {
    checkHost = undefined;
    const steps: CuaVerificationStep[] = [];
    /** Records a step; a defined failure detail fails it. Returns whether it passed. */
    const record = (id: CuaVerificationStepId, failure: string | undefined) => {
      steps.push(failure === undefined ? { id, ok: true } : { id, ok: false, detail: failure });
      return failure === undefined;
    };
    const done = (): DesktopCuaVerification => ({
      verified: steps.length === VERIFICATION_STEPS && steps.every((step) => step.ok),
      steps,
    });
    if ((environment.platform !== "darwin" && environment.platform !== "win32") || closed) {
      record("grants", "Readiness checks run on macOS and Windows.");
      return done();
    }
    const chosen = yield* engine();
    checkingHelper = typeof chosen === "object" && chosen.kind === "helper";
    if (!checkingHelper) yield* forgetHelper(chosen);
    if (typeof chosen === "string") {
      record("grants", chosen);
      return done();
    }
    // Electron's grant APIs are macOS only; on Windows the helper is what reads the desktop.
    if (environment.platform === "win32" && chosen?.kind !== "helper") {
      record(
        "grants",
        `Readiness checks on Windows run through ${COMPUTER_USE_HELPER_NAME}, which this build does not include.`,
      );
      return done();
    }
    const selected = chosen;
    const principal = selected?.kind === "helper" ? COMPUTER_USE_HELPER_NAME : "GOAT";
    const grants = yield* Effect.tryPromise(() =>
      selected ? engineGrants(selected, false) : native.checkGrants(),
    ).pipe(Effect.orElseSucceed((): Grants => ({ accessibility: false, screenRecording: false })));
    if (selected?.kind === "helper") {
      helperSeen = true;
      // A check stands on its own reads: until it proves capture and the tree again, they are not.
      yield* noteHelper((state) => withoutProof(withGrants(state, grants, false)));
    }
    const missing = [
      ...(grants.accessibility ? [] : ["Accessibility"]),
      ...(grants.screenRecording ? [] : ["Screen Recording"]),
    ];
    if (
      !record(
        "grants",
        grants.detail ??
          (missing.length === 0
            ? undefined
            : `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} off for ${principal}.`),
      )
    )
      return done();

    // macOS caches TCC answers per process, so only a fresh driver sees new grants.
    const request = owned ? currentRequest : undefined;
    currentRequest = undefined;
    const stopped = yield* stop;
    // The probe's own helper said what this build can do (#1532), on every platform; the
    // check's own helper may not (the macOS readiness check runs it as an MCP child). It speaks
    // for this desktop only once the helper running before is gone; a check that stopped
    // earlier leaves that helper, and what it said, as they were.
    if (stopped && selected?.kind === "helper") learnHelper(grants.features);
    if (request)
      yield* stopped ? report(request.requestId, "stopped") : unavailable(request.requestId);
    const connection: Option.Option<EmbeddedDriverConnection> =
      selected && stopped
        ? yield* spawn(selected, "verify").pipe(
            Effect.tap((entry) =>
              Effect.sync(() => {
                checkHost = entry;
              }),
            ),
            Effect.flatMap((entry) =>
              Effect.tryPromise(() => entry?.started ?? Promise.reject(new Error("closed"))),
            ),
            Effect.timeout("20 seconds"),
            Effect.option,
          )
        : Option.none();
    if (Option.isNone(connection) || !selected) {
      record(
        "restart",
        selected
          ? "Computer use could not restart. Try again."
          : "Set GOAT_CUA_DRIVER_PATH for development computer use.",
      );
      return done();
    }
    record("restart", undefined);

    const helperMcp = selected.kind === "helper" && environment.platform === "darwin";
    const client = yield* Effect.acquireRelease(
      Effect.tryPromise(() => {
        if (helperMcp) {
          const peer = checkHost?.host.readinessPeer?.();
          return peer ? Promise.resolve(peer) : Promise.reject(new Error("MCP helper unavailable"));
        }
        return native.connect(connection.value.socketPath);
      }).pipe(Effect.option),
      (client) =>
        Effect.sync(() => {
          // The stdio peer ends its helper. Retire must cancel the exit monitor first, or
          // closing a successful check would be recorded as a crash and erase its proof.
          if (!helperMcp && Option.isSome(client)) client.value.uniffiDestroy?.();
        }),
    );
    if (Option.isNone(client)) {
      record("permissions", "Could not connect to the driver. Try again.");
      return done();
    }
    const call = (name: string, input: object): Effect.Effect<ToolCall> =>
      Effect.tryPromise(() => client.value.callTool(name, encodeJson(input))).pipe(
        Effect.timeout("15 seconds"),
        Effect.map((result) => ({
          result,
          structured: Option.getOrUndefined(decodeJson(result.structuredJson)),
        })),
        Effect.option,
      );

    const permissions = yield* call("check_permissions", {});
    if (
      !record(
        "permissions",
        environment.platform === "win32"
          ? (failedCall(permissions) ??
              windowsPermissionsFailure(Option.getOrUndefined(permissions)?.structured))
          : permissionsFailure(permissions),
      )
    )
      return done();
    if (environment.platform === "win32") {
      // health_report skips bundle identity on Windows. The helper host admitted this daemon by
      // the pid the helper started, embedded mode and the helper's id before handing out its
      // pipe (daemonMismatch), so identity holds while that helper still owns it.
      if (
        !record(
          "identity",
          checkServicePid() === undefined
            ? `${COMPUTER_USE_HELPER_NAME} stopped running the driver. Try again.`
            : undefined,
        )
      )
        return done();
    } else {
      const health = yield* call("health_report", { include: ["bundle_identity"] });
      // With the helper, the driver's parent is the helper's service process, not Electron.
      const parentPid = selected.kind === "helper" ? (checkServicePid() ?? -1) : native.processId;
      if (!record("identity", identityFailure(health, engineBundleId(selected), parentPid)))
        return done();
    }

    // The helper's identity as the check above proved it; the proof below needs it unchanged.
    const provenService = selected.kind === "helper" ? checkServicePid() : undefined;
    // Recorded only when it fails: a passing check already recorded its identity step.
    const identityHolds = () =>
      selected.kind !== "helper" ||
      checkServicePid() === provenService ||
      record(
        "identity",
        `${COMPUTER_USE_HELPER_NAME} could not prove it still runs the driver. Try again.`,
      );

    const windows = yield* call("list_windows", { pid: native.processId, on_screen_only: true });
    const windowId = Option.flatMap(windows, ({ structured }) =>
      Option.fromNullishOr(readNumber(readArray(structured, "windows")[0], "window_id")),
    );
    if (Option.isNone(windowId)) {
      const detail = "Keep a GOAT window open on screen, then try again.";
      record("capture", detail);
      if (!identityHolds()) return done();
      yield* noteChecked((state) =>
        withProof(state, { capture: "noWindow", screenLocked: false, details: [detail] }),
      );
      return done();
    }
    const state = yield* call("get_window_state", {
      pid: native.processId,
      window_id: windowId.value,
    });
    const degraded = Option.flatMap(state, ({ structured }) =>
      Option.fromNullishOr(readString(structured, "degraded_reason")),
    );
    const screenLocked = Option.exists(degraded, (reason) => reason.startsWith("screen_locked"));
    const degradedDetail = degraded.pipe(Option.map(describeDegraded), Option.getOrUndefined);
    const image = Option.flatMap(state, ({ result }) => Option.fromNullishOr(result.images[0]));
    const captured = Option.isSome(image)
      ? yield* Effect.tryPromise(() => native.imageHasContent(image.value)).pipe(
          Effect.orElseSucceed(() => false),
        )
      : false;
    const captureFailure = captured
      ? undefined
      : (degradedDetail ??
        (Option.isSome(image)
          ? "The screenshot was blank. Check Screen Recording, then try again."
          : "The driver returned no screenshot. Check Screen Recording, then try again."));
    if (!record("capture", captureFailure)) {
      const proof: HelperProof = {
        capture: Option.isSome(image) && degradedDetail === undefined ? "blank" : "unavailable",
        screenLocked,
        details: captureFailure === undefined ? [] : [captureFailure],
      };
      if (!identityHolds()) return done();
      yield* noteChecked((current) => withProof(current, proof));
      return done();
    }
    const elements = Option.match(state, {
      onNone: () => 0,
      onSome: ({ structured }) =>
        readNumber(structured, "element_count") ?? readArray(structured, "elements").length,
    });
    const treeFailure =
      elements > 0
        ? undefined
        : (degradedDetail ?? "The driver could not read GOAT's window. Check Accessibility.");
    record("accessibility", treeFailure);
    if (!identityHolds()) return done();
    yield* noteChecked((current) =>
      withProof(current, {
        capture: "ready",
        elements,
        screenLocked,
        details: treeFailure === undefined ? [] : [treeFailure],
      }),
    );
    return done();
  }).pipe(
    Effect.scoped,
    // A check that stopped before reading a window says why nothing is proven.
    Effect.tap((result) => {
      const early = result.steps.find(
        (step) =>
          !step.ok &&
          (step.id === "restart" || step.id === "permissions" || step.id === "identity"),
      );
      return early ? noteChecked((state) => withoutProof(state, early.detail)) : Effect.void;
    }),
    // Only the check's own generation is stopped here: nothing else holds it. A driver that was
    // already serving an agent is retired only by the restart step, which reports "stopped".
    Effect.ensuring(
      Effect.suspend(() => (checkHost !== undefined && owned === checkHost ? stop : Effect.void)),
    ),
    mutex.withPermits(1),
    Effect.withSpan("desktop.cua.verify"),
  );

  const handleRequest = Effect.fn("desktop.cua.request")(function* (
    request: DesktopCuaDriverRequest,
  ) {
    if (closed) return;
    currentRequest = request;
    if (!request.enabled) {
      const stopped = yield* stop;
      yield* stopped ? report(request.requestId, "stopped") : unavailable(request.requestId);
      return;
    }
    if (owned?.cleanup) {
      yield* unavailable(request.requestId);
      return;
    }
    const selected = yield* engine();
    if (typeof selected !== "object" || selected.kind !== "helper") yield* forgetHelper(selected);
    if (typeof selected === "string") {
      yield* report(request.requestId, "unavailable", selected);
      return;
    }
    if (!selected) {
      yield* report(
        request.requestId,
        "unavailable",
        "Set GOAT_CUA_DRIVER_PATH for development computer use.",
      );
      return;
    }

    yield* Effect.gen(function* () {
      if (!owned) {
        // A new helper starts: until its hello is read below, nothing it can do is known.
        if (selected.kind === "helper") learnHelper(undefined);
        if (environment.platform === "darwin") {
          // Prompts as whoever owns the grants: the helper when it ships, else GOAT itself.
          const grants = yield* Effect.tryPromise(() => engineGrants(selected, true));
          if (selected.kind === "helper") {
            helperSeen = true;
            yield* noteHelper((state) => withGrants(state, grants, true));
          }
          if (!grants.accessibility || !grants.screenRecording) {
            yield* ungranted(
              request.requestId,
              grants,
              selected.kind === "helper" ? "helper" : "app",
            );
            return;
          }
        } else if (selected.kind === "helper") {
          // Windows has no grant to prompt for; a desktop the helper cannot use says why.
          const ready = yield* Effect.tryPromise(() => engineGrants(selected, false));
          helperSeen = true;
          yield* noteHelper((state) => withGrants(state, ready, false));
          if (ready.detail !== undefined || !ready.accessibility || !ready.screenRecording) {
            yield* desktopUnavailable(
              request.requestId,
              ready.detail ?? `${COMPUTER_USE_HELPER_NAME} cannot use this desktop.`,
              ready.blocker,
            );
            return;
          }
        }
        if (!(yield* spawn(selected, "agents"))) return;
      }
      const entry = owned!;
      const connection = yield* Effect.tryPromise(() => entry.started).pipe(
        Effect.timeout("20 seconds"),
      );
      const mcp = yield* decodeMcp({
        ...connection.mcp,
        ...(connection.socketPath === "" ? {} : { socketPath: connection.socketPath }),
      });
      const session = entry.host.session?.();
      if (entry.helper) {
        learnHelper(session);
        yield* noteHelper((state) => withRunning(state, true));
      }
      if (session) yield* followers.attach(session);
      if (!closed)
        yield* publisher.publishCuaReport({
          version: 1,
          type: "cuaDriverReport",
          requestId: request.requestId,
          status: "ready",
          mcp,
        });
    }).pipe(
      Effect.catch((error) =>
        stop.pipe(
          // A helper that could not start, such as one whose identity no longer matches, is
          // not the one an earlier check confirmed.
          Effect.andThen(
            selected.kind === "helper"
              ? noteHelper((state) =>
                  withoutProof(
                    state,
                    `${COMPUTER_USE_HELPER_NAME} could not start. Run the readiness check again.`,
                  ),
                )
              : Effect.void,
          ),
          Effect.andThen(
            isCuaDriverStartupRefusal(error)
              ? report(
                  request.requestId,
                  "unavailable",
                  "Cua Driver refused GOAT's capability manifest or launch options. The desktop log has the driver's reason.",
                )
              : // On Windows the helper owns the desktop; one that could not start is the reason.
                environment.platform === "win32" && selected.kind === "helper"
                ? desktopUnavailable(
                    request.requestId,
                    `${COMPUTER_USE_HELPER_NAME} could not start. Restart GOAT on this computer, then try again.`,
                  )
                : unavailable(request.requestId),
          ),
        ),
      ),
    );
  }, mutex.withPermits(1));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      yield* stop;
    }),
  );

  const grantTarget = Effect.gen(function* () {
    const chosen = environment.platform === "darwin" ? yield* engine() : undefined;
    return cuaGrantTarget({
      platform: environment.platform,
      engine: chosen,
      appBundleId: environment.appUserModelId,
      readHelper: () =>
        chosen !== undefined && typeof chosen !== "string"
          ? engineGrants(chosen, false)
          : Promise.reject(new Error("no helper")),
      readApp: native.checkGrants,
    });
  }).pipe(Effect.withSpan("desktop.cua.grantTarget"));
  const grants = grantTarget.pipe(
    Effect.flatMap((target) => readCuaGrants(target, environment.displayName)),
  );

  return DesktopCuaDriver.of({
    restart,
    verify,
    grantTarget,
    grants,
    listen: Effect.gen(function* () {
      yield* Stream.runForEach(publisher.cuaAppsRequests, handleAppsRequest).pipe(
        Effect.forkScoped,
      );
      yield* Stream.runForEach(publisher.cuaRequests, handleRequest).pipe(Effect.forkScoped);
      yield* publisher.cuaWatchApps.pipe(
        Stream.runForEach((apps) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              const entry = owned;
              if (closed || !entry || entry.cleanup) return;
              if ((yield* entry.refreshManifest(apps)) && !entry.direct) yield* restartHost;
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not refresh Cua Driver manifest", { cause }),
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      yield* followers.listen;
      yield* Effect.forever(
        Queue.take(crashes).pipe(
          Effect.flatMap((entry) =>
            mutex.withPermits(1)(
              Effect.gen(function* () {
                if (closed) return;
                // A helper that exited on its own is not known to be the one a check confirmed,
                // even when its owner went away before this ran.
                yield* forgetCrash(entry);
                if (owned !== entry || entry.cleanup) return;
                const request = currentRequest;
                yield* stop;
                if (request) yield* unavailable(request.requestId);
              }),
            ),
          ),
        ),
      ).pipe(Effect.forkScoped);
    }),
  });
});

export const layer = Layer.effect(DesktopCuaDriver, make());
