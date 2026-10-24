import {
  type ComputerUseReadiness,
  CuaDriverMcpConfiguration,
  type CuaVerificationStep,
  type CuaVerificationStepId,
  type DesktopCuaDriverRequest,
  type DesktopCuaVerification,
} from "@goat/contracts";
import {
  CUA_DRIVER_VERIFY_TOOLS,
  cuaDriverCapabilityManifest,
  isCuaDriverStartupRefusal,
  prepareCuaDriverCapabilityManifest,
  writeCuaDriverCapabilityManifest,
} from "@goat/shared/cuaDriverManifest";
import type { CuaDriverListedApp } from "@goat/shared/cuaDriverManifest";
import {
  COMPUTER_USE_HELPER_NAME,
  computerUseHelperBundleId,
  cuaDriverHostOptions,
  cuaDriverListingEnvironment,
  cuaDriverRelease,
} from "@goat/shared/cuaDriverRelease";
import type { CuaDriverLike, ToolResult } from "@trycua/cua-driver";
import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import {
  HELPER_SIGNALS,
  initialHelperReadiness,
  toReadiness,
  withGrants,
  withProof,
  withRunning,
  withoutProof,
  type HelperProof,
  type HelperReadinessState,
} from "./helperReadiness.ts";
import {
  classifyHelperBundle,
  helperBundle,
  makeHelperHost,
  listHelperApplications,
  probeHelperGrants,
  spawnHelperProcess,
  type DaemonMetadata,
  type HelperBundle,
  type HelperHostOptions,
} from "./ComputerUseHelper.ts";
import {
  probeWindowsReadiness,
  windowsDriverPipe,
  windowsHelperBundle,
  windowsPermissionsFailure,
} from "./ComputerUseHelperWindows.ts";

/** The daemon lifecycle both engines share: the SDK's in-process host and the helper app. */
interface NativeHost {
  readonly start: () => Promise<EmbeddedDriverConnection>;
  readonly stop: () => Promise<void>;
  readonly waitForExit: (
    generation: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<unknown>;
  readonly uniffiDestroy: () => void;
  /** The helper's service pid, the driver's parent; absent for the in-process host. */
  readonly servicePid?: () => number | undefined;
}
type DriverClient = Pick<CuaDriverLike, "callTool"> & { readonly uniffiDestroy?: () => void };
type DriverImage = ToolResult["images"][number];
/** detail: why a Windows desktop is not ready, in onboarding's words; Windows has no grant to give. */
type Grants = {
  accessibility: boolean;
  screenRecording: boolean;
  readonly detail?: string;
  readonly blocker?: ComputerUseReadiness["blockers"][number];
};

/**
 * Who runs the driver. "helper": GOAT Computer Use.app owns the TCC identity and spawns the
 * driver (D1). "embedded": the SDK spawns it from this Electron process, for builds that do not
 * ship the helper yet.
 */
type Engine =
  | { readonly kind: "helper"; readonly bundle: HelperBundle }
  | { readonly kind: "embedded"; readonly driverPath: string };

/**
 * Agents get the general manifest, which leaves GOAT's own windows out. The grant check is the
 * one daemon no agent ever holds, so its manifest admits only GOAT, the window it reads.
 */
export type CuaManifestScope = "agents" | "verify";

export interface DesktopCuaDriverDependencies {
  readonly loadEmbedded: () => Promise<{
    readonly EmbeddedCuaDriverHost: {
      readonly withOptions: (options: ReturnType<typeof cuaDriverHostOptions>) => NativeHost;
    };
  }>;
  readonly loadElectron: () => Promise<
    Pick<
      typeof import("@trycua/cua-driver/electron"),
      "requestMacOSPermissions" | "hasRequiredMacOSPermissions"
    >
  >;
  /** SDK client bound to one daemon generation's socket. */
  readonly connect: (socketPath: string) => Promise<DriverClient>;
  /** Electron's view of the grants, read without prompting. */
  readonly checkGrants: () => Promise<Grants>;
  /** The helper's own grants, from a fresh helper process; prompts as the helper when asked. */
  readonly helperGrants: (
    bundle: HelperBundle,
    prompt: boolean,
    platform: NodeJS.Platform,
  ) => Promise<Grants>;
  /**
   * The helper bundle this build ships. absent: the build has none, and GOAT itself runs the
   * driver as releases did before the helper. unusable: it should be there and cannot be used,
   * so computer use stays off rather than run under another principal.
   */
  readonly helperBundlePath: (input: {
    readonly isPackaged: boolean;
    readonly resourcesPath: string;
    readonly platform: NodeJS.Platform;
  }) => Promise<
    | { readonly kind: "found"; readonly path: string }
    | { readonly kind: "absent" }
    | { readonly kind: "unusable"; readonly message: string }
  >;
  readonly helperHost: (
    options: Omit<HelperHostOptions, "spawn" | "readMetadata"> & {
      readonly platform: NodeJS.Platform;
    },
  ) => NativeHost;
  readonly imageHasContent: (image: DriverImage) => Promise<boolean>;
  /** Writes the capability manifest for one daemon start and returns its path. */
  readonly prepareManifest: (input: {
    readonly binaryPath: string;
    readonly scope: CuaManifestScope;
    readonly hostBundleIds: ReadonlyArray<string>;
    readonly directory: string;
    readonly platform: NodeJS.Platform;
    /** Lists apps through the helper, so the driver never runs outside its seal check. */
    readonly listApplications?: () => Promise<ReadonlyArray<CuaDriverListedApp>>;
  }) => Promise<string>;
  /** The apps the macOS helper's driver lists, after the helper verifies it (#1241). */
  readonly helperApps: (bundle: HelperBundle) => Promise<ReadonlyArray<CuaDriverListedApp>>;
  readonly processId: number;
  /** Windows manifests name apps by executable path, so GOAT's own is how they name GOAT. */
  readonly executablePath: string;
}

/** A capture of a locked or unauthorized screen is all black; real content varies. */
export function bitmapHasContent(bitmap: Uint8Array): boolean {
  const pixels = Math.floor(bitmap.length / 4);
  if (pixels === 0) return false;
  const stride = Math.max(1, Math.floor(pixels / 4096));
  let lit = 0;
  let sampled = 0;
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const offset = pixel * 4;
    sampled++;
    if (Math.max(bitmap[offset]!, bitmap[offset + 1]!, bitmap[offset + 2]!) > 16) lit++;
  }
  return lit / sampled >= 0.01;
}

/**
 * The manifest for one daemon start. The grant check's admits only GOAT and needs no listing;
 * the agents' lists apps through listApplications when the engine gives it one, so a helper
 * that verifies its driver is the only thing that runs it.
 */
export async function prepareDesktopManifest(
  input: Parameters<DesktopCuaDriverDependencies["prepareManifest"]>[0],
): Promise<string> {
  const { join } = await import("node:path");
  return input.scope === "verify"
    ? writeCuaDriverCapabilityManifest(
        join(input.directory, "verify-manifest.yaml"),
        cuaDriverCapabilityManifest({
          applications: input.hostBundleIds,
          tools: CUA_DRIVER_VERIFY_TOOLS,
        }),
      )
    : prepareCuaDriverCapabilityManifest({
        binaryPath: input.binaryPath,
        platform: input.platform,
        environment: cuaDriverListingEnvironment(process.env),
        hostBundleIds: input.hostBundleIds,
        path: join(input.directory, "capability-manifest.yaml"),
        ...(input.listApplications ? { listApplications: input.listApplications } : {}),
      });
}

const dependencies: DesktopCuaDriverDependencies = {
  loadEmbedded: async () => {
    const sdk = await import("@trycua/cua-driver/embedded");
    return {
      EmbeddedCuaDriverHost: {
        // A UniFFI constructor: it returns the concrete host, typed as its interface.
        withOptions: (options) =>
          sdk.EmbeddedCuaDriverHost.withOptions(options) as EmbeddedCuaDriverHost,
      },
    };
  },
  loadElectron: () => import("@trycua/cua-driver/electron"),
  connect: async (socketPath) => (await import("@trycua/cua-driver")).CuaDriver.connect(socketPath),
  checkGrants: async () => {
    const { systemPreferences } = await import("electron");
    return {
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screenRecording: systemPreferences.getMediaAccessStatus("screen") === "granted",
    };
  },
  helperGrants: (bundle, prompt, platform) =>
    platform === "win32"
      ? probeWindowsReadiness(spawnHelperProcess(bundle.executable, platform), bundle.bundleId)
      : probeHelperGrants(spawnHelperProcess(bundle.executable, platform), bundle.bundleId, prompt),
  helperBundlePath: async ({ isPackaged, resourcesPath, platform }) => {
    const { join } = await import("node:path");
    const configured = isPackaged ? undefined : process.env.GOAT_CUA_HELPER_PATH?.trim();
    if (!isPackaged && !configured) return { kind: "absent" };
    // A set dev path must exist; only a packaged build with nothing at the helper's place falls back.
    return platform === "win32"
      ? classifyHelperBundle(
          configured || join(resourcesPath, "computer-use-helper"),
          configured !== undefined,
          (path) => windowsHelperBundle(path, "").executable,
        )
      : classifyHelperBundle(
          configured || join(resourcesPath, "..", "Helpers", COMPUTER_USE_HELPER_NAME + ".app"),
          configured !== undefined,
        );
  },
  helperHost: ({ platform, ...options }) =>
    makeHelperHost({
      ...options,
      spawn: (executable) => spawnHelperProcess(executable, platform),
      ...(platform === "win32" ? { socket: windowsDriverPipe } : {}),
      readMetadata: async (socketPath): Promise<DaemonMetadata> => {
        const driver: DriverClient & Pick<CuaDriverLike, "metadata"> = (
          await import("@trycua/cua-driver")
        ).CuaDriver.connect(socketPath);
        try {
          return await driver.metadata();
        } finally {
          driver.uniffiDestroy?.();
        }
      },
    }),
  imageHasContent: async (image) => {
    const { nativeImage } = await import("electron");
    const decoded = nativeImage.createFromBuffer(Buffer.from(image.dataBase64, "base64"));
    return !decoded.isEmpty() && bitmapHasContent(decoded.toBitmap());
  },
  prepareManifest: prepareDesktopManifest,
  helperApps: (bundle) =>
    listHelperApplications(spawnHelperProcess(bundle.executable, "darwin"), bundle.bundleId),
  processId: process.pid,
  executablePath: process.execPath,
};

interface OwnedHost {
  readonly host: NativeHost;
  readonly abort: AbortController;
  readonly started: Promise<EmbeddedDriverConnection>;
  /** Run by GOAT Computer Use; only such a host makes the helper's readiness "running". */
  readonly helper: boolean;
  monitor?: Promise<void>;
  cleanup?: Promise<void>;
}

export class DesktopCuaDriver extends Context.Service<
  DesktopCuaDriver,
  {
    readonly listen: Effect.Effect<void, never, import("effect/Scope").Scope>;
    readonly restart: Effect.Effect<void>;
    readonly verify: Effect.Effect<DesktopCuaVerification>;
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

type ToolCall = Option.Option<{ readonly result: ToolResult; readonly structured: unknown }>;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
const readString = (value: unknown, key: string) => {
  const found = field(value, key);
  return typeof found === "string" ? found : undefined;
};
const readNumber = (value: unknown, key: string) => {
  const found = field(value, key);
  return typeof found === "number" ? found : undefined;
};
const readArray = (value: unknown, key: string): readonly unknown[] => {
  const found = field(value, key);
  return Array.isArray(found) ? found : [];
};

/** Drops the driver's diagnostic tail; the first clause names the cause. */
function describeDegraded(reason: string): string {
  if (reason.startsWith("screen_locked"))
    return "The screen is locked. Unlock this Mac, then try again.";
  return `The driver could not see GOAT's window (${reason.split(/[.:]/u, 1)[0]!.replaceAll("_", " ")}).`;
}

function failedCall(call: ToolCall): string | undefined {
  if (Option.isNone(call)) return "The driver did not answer. Try again.";
  if (call.value.result.isError)
    return call.value.result.text.trim() || "The driver reported an error.";
  return undefined;
}

/** Each check returns why it failed, or undefined when it passed. */
function permissionsFailure(call: ToolCall): string | undefined {
  const error = failedCall(call);
  if (error !== undefined || Option.isNone(call)) return error;
  const { structured } = call.value;
  if (readString(field(structured, "source"), "attribution") !== "host")
    return "The driver is not running under GOAT's permissions. Restart GOAT.";
  const missing = [
    ...(field(structured, "accessibility") === true ? [] : ["Accessibility"]),
    ...(field(structured, "screen_recording") === true ? [] : ["Screen Recording"]),
  ];
  return missing.length === 0
    ? undefined
    : `The driver does not see ${missing.join(" or ")} yet. Quit and reopen GOAT.`;
}

function identityFailure(call: ToolCall, bundleId: string, processId: number): string | undefined {
  const error = failedCall(call);
  if (error !== undefined || Option.isNone(call)) return error;
  const check = readArray(call.value.structured, "checks").find(
    (entry) => readString(entry, "name") === "bundle_identity",
  );
  const data = field(check, "data");
  const ok =
    readString(check, "status") === "pass" &&
    readString(data, "identity_source") === "parent_application" &&
    readString(data, "bundle_identifier") === bundleId &&
    readNumber(data, "parent_process_id") === processId;
  return ok
    ? undefined
    : (readString(check, "message") ?? "The driver could not confirm it runs inside GOAT.");
}

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
        signals: HELPER_SIGNALS,
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
    noteHelper((state) =>
      withoutProof(
        withRunning(state, false),
        typeof chosen === "string" ? chosen : `${COMPUTER_USE_HELPER_NAME} could not be found.`,
      ),
    );

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
  const stop = Effect.suspend(() =>
    owned
      ? Effect.tryPromise(() => retire(owned!)).pipe(
          Effect.timeoutOption("2 seconds"),
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => false),
        )
      : Effect.succeed(true),
  ).pipe(Effect.tap(() => noteHelper((state) => withRunning(state, false))));
  const report = (requestId: string, status: "stopped" | "unavailable", message?: string) =>
    closed
      ? Effect.void
      : publisher.publishCuaReport({
          version: 1,
          type: "cuaDriverReport",
          requestId,
          status,
          ...(message === undefined ? {} : { message }),
        });
  const unavailable = (requestId: string) =>
    report(
      requestId,
      "unavailable",
      "Computer use is unavailable. Try again after the driver has stopped.",
    );

  const restart = mutex.withPermits(1)(
    Effect.gen(function* () {
      const request = owned ? currentRequest : undefined;
      currentRequest = undefined;
      const stopped = yield* stop;
      if (request)
        yield* stopped ? report(request.requestId, "stopped") : unavailable(request.requestId);
    }),
  );

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
      const found = yield* Effect.tryPromise(() =>
        native.helperBundlePath({
          isPackaged: environment.isPackaged,
          resourcesPath: environment.resourcesPath,
          platform: environment.platform,
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
        const bundleId = computerUseHelperBundleId(environment.appUserModelId);
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

  const spawn = Effect.fn("desktop.cua.spawn")(function* (engine: Engine, scope: CuaManifestScope) {
    // Which app macOS charges the grants to, so a log shows who held them.
    yield* Effect.logInfo("Starting Cua Driver", {
      scope,
      principal: engine.kind === "helper" ? engine.bundle.bundleId : environment.appUserModelId,
    });
    const manifestPath = yield* Effect.tryPromise(() =>
      native.prepareManifest({
        binaryPath: enginePath(engine),
        scope,
        hostBundleIds: hostBundleIds(engine),
        directory: environment.path.join(environment.stateDir, "cua-driver"),
        platform: environment.platform,
        // The macOS helper verifies its driver before running it, so it lists the apps too;
        // running the driver here would execute it unchecked, under GOAT's identity.
        ...(engine.kind === "helper" && environment.platform === "darwin"
          ? { listApplications: () => native.helperApps(engine.bundle) }
          : {}),
      }),
    );
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
    };
    owned = entry;
    void entry.started.then(
      (connection) => {
        entry.monitor = settle(
          Promise.resolve().then(() =>
            host.waitForExit(connection.generation, { signal: entry.abort.signal }),
          ),
        ).then(() => {
          if (!entry.cleanup && !closed) Queue.offerUnsafe(crashes, entry);
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

    const client = yield* Effect.acquireRelease(
      Effect.tryPromise(() => native.connect(connection.value.socketPath)).pipe(Effect.option),
      (client) =>
        Effect.sync(() => {
          if (Option.isSome(client)) client.value.uniffiDestroy?.();
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

    const windows = yield* call("list_windows", { pid: native.processId, on_screen_only: true });
    const windowId = Option.flatMap(windows, ({ structured }) =>
      Option.fromNullishOr(readNumber(readArray(structured, "windows")[0], "window_id")),
    );
    if (Option.isNone(windowId)) {
      const detail = "Keep a GOAT window open on screen, then try again.";
      record("capture", detail);
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
        if (environment.platform === "darwin") {
          // Prompts as whoever owns the grants: the helper when it ships, else GOAT itself.
          const grants = yield* Effect.tryPromise(() => engineGrants(selected, true));
          if (selected.kind === "helper") {
            helperSeen = true;
            yield* noteHelper((state) => withGrants(state, grants, true));
          }
          if (!grants.accessibility || !grants.screenRecording) {
            yield* report(
              request.requestId,
              "unavailable",
              selected.kind === "helper"
                ? `Allow Accessibility and Screen Recording for ${COMPUTER_USE_HELPER_NAME} in System Settings, then restart computer use.`
                : "Allow Accessibility and Screen Recording in System Settings, then restart computer use.",
            );
            return;
          }
        } else if (selected.kind === "helper") {
          // Windows has no grant to prompt for; a desktop the helper cannot use says why.
          const ready = yield* Effect.tryPromise(() => engineGrants(selected, false));
          helperSeen = true;
          yield* noteHelper((state) => withGrants(state, ready, false));
          if (ready.detail !== undefined || !ready.accessibility || !ready.screenRecording) {
            yield* report(
              request.requestId,
              "unavailable",
              ready.detail ?? `${COMPUTER_USE_HELPER_NAME} cannot use this desktop.`,
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
      const mcp = yield* decodeMcp({ ...connection.mcp, socketPath: connection.socketPath });
      if (entry.helper) yield* noteHelper((state) => withRunning(state, true));
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
          Effect.andThen(
            isCuaDriverStartupRefusal(error)
              ? report(
                  request.requestId,
                  "unavailable",
                  "Cua Driver refused GOAT's capability manifest or launch options. The desktop log has the driver's reason.",
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

  return DesktopCuaDriver.of({
    restart,
    verify,
    listen: Effect.gen(function* () {
      yield* Stream.runForEach(publisher.cuaRequests, handleRequest).pipe(Effect.forkScoped);
      yield* Effect.forever(
        Queue.take(crashes).pipe(
          Effect.flatMap((entry) =>
            mutex.withPermits(1)(
              Effect.gen(function* () {
                if (owned !== entry || entry.cleanup || closed) return;
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
