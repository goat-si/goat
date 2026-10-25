// Shared fixture for the DesktopCuaDriver suites; one fake per native dependency.
import * as NodePath from "@effect/platform-node/NodePath";
import type {
  ComputerUseReadiness,
  DesktopCuaAppsReport,
  DesktopCuaDriverReport,
  DesktopCuaDriverRequest,
  DesktopCuaPrivateModeReport,
  DesktopCuaReadinessReport,
} from "@goat/contracts";
import {
  admittedCuaApplications,
  cuaDriverCapabilityManifest,
  type CuaDriverListedApp,
} from "@goat/shared/cuaDriverManifest";
import type { ToolResult } from "@trycua/cua-driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { DesktopTelemetryPublisher } from "../telemetry/DesktopTelemetryPublisher.ts";
import type { HelperEvent } from "./ComputerUseHelper.ts";
import { make, type DesktopCuaDriverDependencies } from "./DesktopCuaDriver.ts";

// The embedded allowlist forwards only these opt-outs; DO_NOT_TRACK would fail construction.
export const privacyEnvironment = [
  { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" },
  { name: "CUA_TELEMETRY_ENABLED", value: "false" },
  { name: "CUA_DRIVER_RS_UPDATE_CHECK", value: "false" },
];

export const descriptor = {
  command: "/native/driver",
  args: ["mcp", "--session", "opaque-session"],
  environment: [{ name: "CUA_SESSION", value: "private-session-token" }],
  socketPath: "/private/driver.sock",
};

export const HOST_PID = 4242;
export const HELPER_PID = 5151;
export const HELPER_ID = "codes.t3.host-test.computer-use";
export const HELPER_BUNDLE = "/Helpers/GOAT Computer Use.app";

/** The helper's answer to a grant check; detail and blocker are its Windows refusal. */
export interface HelperAnswer {
  readonly granted: boolean;
  readonly detail?: string;
  readonly blocker?: ComputerUseReadiness["blockers"][number];
  /** Fails the read the way a helper that cannot answer does. */
  readonly fails?: Error;
}

export const toolResult = (structured: unknown, images: ToolResult["images"] = []): ToolResult => ({
  text: "",
  images,
  structuredJson: JSON.stringify(structured),
  isError: false,
  degraded: false,
  rawJson: "{}",
});

// Shapes recorded from the pinned 0.37.0 daemon, trimmed to the fields the verifier reads.
export const healthyTools = (): Record<string, ToolResult> => ({
  check_permissions: toolResult({
    accessibility: true,
    screen_recording: true,
    source: { attribution: "host", embedded: true, host_bundle_id: "codes.t3.host-test" },
  }),
  health_report: toolResult({
    checks: [
      {
        name: "bundle_identity",
        status: "pass",
        data: {
          bundle_identifier: "codes.t3.host-test",
          identity_source: "parent_application",
          parent_process_id: HOST_PID,
        },
      },
    ],
  }),
  list_windows: toolResult({ windows: [{ app_name: "GOAT", pid: HOST_PID, window_id: 77 }] }),
  get_window_state: toolResult({ app_name: "GOAT", element_count: 42 }, [
    { mimeType: "image/png", dataBase64: "cGl4ZWxz" },
  ]),
});

export const fixture = Effect.fn(function* (
  options: {
    platform?: NodeJS.Platform;
    isPackaged?: boolean;
    denyPermissions?: boolean;
    failFirstStart?: boolean;
    hold?: "start" | "stop" | "monitor";
    tools?: Record<string, ToolResult>;
    /** After this tool answers, the helper's service identity is withdrawn (a second hello). */
    withdrawIdentityAfter?: string;
    blankCapture?: boolean;
    refuseStart?: boolean;
    /** Ship the GOAT Computer Use helper; its grants are separate from Electron's. */
    helper?: HelperAnswer | "unusable";
    /** A helper build from before the watch method: its hello lists no features. */
    helperWithoutWatch?: boolean;
    /** A helper build whose agent connections do not report a person's input. */
    helperWithoutInput?: boolean;
    /** The helper refuses to list apps, as it does for a driver that fails its seal check. */
    helperAppsFail?: boolean;
    /** The app update puts a new helper generation beside the one already running. */
    updatedHelper?: boolean;
    publisher?: DesktopTelemetryPublisher["Service"];
    appListing?: () => Promise<ReadonlyArray<CuaDriverListedApp>>;
  } = {},
) {
  const appRequests = yield* Queue.sliding<void>(1);
  const pendingAppRequests = new Set<string>();
  const appReports = yield* Queue.unbounded<DesktopCuaAppsReport>();
  let computerUseEnabled = true;
  const requests = yield* Queue.unbounded<DesktopCuaDriverRequest>();
  const reports = yield* Queue.unbounded<DesktopCuaDriverReport>();
  const readiness: DesktopCuaReadinessReport[] = [];
  const watching = yield* Queue.unbounded<boolean>();
  const approvals = yield* Queue.unbounded<{
    apps: ReadonlyArray<string>;
    done: Deferred.Deferred<void>;
  }>();
  const manifests = new Map<string, string>();
  let listedApps: ReadonlyArray<CuaDriverListedApp> = [
    { bundle_id: "com.apple.TextEdit", name: "TextEdit" },
  ];
  const safety: DesktopCuaPrivateModeReport[] = [];
  const safetyHeard = yield* Queue.unbounded<void>();
  /** The helper's watch calls, in order, and a way to raise its private-mode event. */
  const helperWatches = yield* Queue.unbounded<"watch" | "unwatch">();
  let raise: ((active: boolean, windowId: number) => void) | undefined;
  const starting = yield* Deferred.make<void>();
  const stopping = yield* Deferred.make<void>();
  const destroyed = yield* Queue.unbounded<void>();
  const agentMonitors = yield* Queue.unbounded<Effect.Effect<void>>();
  const gate = Promise.withResolvers<void>();
  const constructors: Array<{
    path: string;
    bundleId: string;
    environment: ReadonlyArray<{ name: string; value: string }>;
  }> = [];
  const exits: Array<() => void> = [];
  const launches: Array<{
    scope: string;
    hostBundleIds: ReadonlyArray<string>;
    manifestPath: string | undefined;
    permissionMode: number | undefined;
    approved: boolean;
  }> = [];
  const prepared = new Map<string, { scope: string; hostBundleIds: ReadonlyArray<string> }>();
  const holdMonitor = options.hold === "monitor";
  let allowed = !options.denyPermissions;
  let helperAnswer = typeof options.helper === "object" ? options.helper : undefined;
  let helperLost: "unusable" | "absent" | undefined;
  let updatedHelper = options.updatedHelper === true;
  let starts = 0;
  let stops = 0;
  let destroys = 0;
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  let clientsOpen = 0;
  let socketConnections = 0;
  const helperProbes: Array<{ bundleId: string; prompt: boolean }> = [];
  /** How each manifest got its app list: through the helper, or by running the driver here. */
  const manifestListings: Array<{ scope: string; through: "helper" | "driver"; apps: number }> = [];
  const helperAppListings: string[] = [];
  let appListingFails = options.helperAppsFail === true;
  const helperLaunches: Array<{
    bundleId: string;
    driverPath: string;
    manifestPath: string;
    environment: ReadonlyArray<{ name: string; value: string }>;
    direct: boolean;
    verify: boolean;
  }> = [];
  let identityWithdrawn = false;
  const createClient = (): Awaited<ReturnType<DesktopCuaDriverDependencies["connect"]>> => {
    clientsOpen++;
    return {
      callTool: async (name, input) => {
        toolCalls.push({ name, input: JSON.parse(input) });
        const result = (options.tools ?? healthyTools())[name];
        if (!result) throw new Error(`unexpected tool ${name}`);
        if (name === options.withdrawIdentityAfter) identityWithdrawn = true;
        return result;
      },
      uniffiDestroy: () => {
        clientsOpen--;
      },
    };
  };
  const dependencies: DesktopCuaDriverDependencies = {
    connect: async () => {
      socketConnections++;
      return createClient();
    },
    checkGrants: async () => ({ accessibility: allowed, screenRecording: allowed }),
    helperGrants: async (bundle, prompt) => {
      helperProbes.push({ bundleId: bundle.bundleId, prompt });
      if (helperAnswer?.fails) throw helperAnswer.fails;
      const granted = helperAnswer?.granted ?? false;
      return {
        accessibility: granted,
        screenRecording: granted,
        ...(helperAnswer?.detail === undefined ? {} : { detail: helperAnswer.detail }),
        ...(helperAnswer?.blocker === undefined ? {} : { blocker: helperAnswer.blocker }),
      };
    },
    helperBundlePath: async ({ busy }) =>
      options.helper === "unusable" || helperLost === "unusable"
        ? { kind: "unusable", message: "GOAT Computer Use at /Helpers cannot be used (EACCES)." }
        : options.helper && helperLost === undefined
          ? {
              kind: "found",
              path: updatedHelper && !busy ? HELPER_BUNDLE + "/generations/new" : HELPER_BUNDLE,
            }
          : { kind: "absent" },
    helperHost: (helper) => {
      helperLaunches.push({
        bundleId: helper.bundle.bundleId,
        driverPath: helper.bundle.driverPath,
        manifestPath: helper.capabilityManifestPath,
        environment: helper.environment,
        direct: helper.direct === true,
        verify: helper.verify === true,
      });
      const manifest = prepared.get(helper.capabilityManifestPath);
      launches.push({
        scope: manifest?.scope ?? "none",
        hostBundleIds: manifest?.hostBundleIds ?? [],
        manifestPath: helper.capabilityManifestPath,
        permissionMode: 0,
        approved: true,
      });
      const exit = Promise.withResolvers<void>();
      let running = false;
      let readinessClient: ReturnType<typeof createClient> | undefined;
      let listener: ((event: HelperEvent["event"]) => void) | undefined;
      const session = {
        canWatch: options.helperWithoutWatch !== true,
        reportsInput: options.helperWithoutWatch !== true && options.helperWithoutInput !== true,
        canFrame: false,
        frames: async () => undefined,
        onFrame: () => () => undefined,
        watch: async (_watchId: string) => {
          Queue.offerUnsafe(helperWatches, "watch");
          // A watch's first state follows its answer.
          raise = (active, windowId) =>
            listener?.({ type: "privateMode", active, target: { pid: 7, windowId } });
        },
        unwatch: async () => {
          Queue.offerUnsafe(helperWatches, "unwatch");
        },
        onEvent: (next: (event: HelperEvent["event"]) => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      };
      return {
        servicePid: () => (running && !identityWithdrawn ? HELPER_PID : undefined),
        readinessPeer: () => readinessClient,
        session: () => (running ? session : undefined),
        start: async () => {
          starts++;
          running = true;
          if (helper.verify) {
            const peer = createClient();
            let closed = false;
            readinessClient = {
              ...peer,
              uniffiDestroy: () => {
                if (closed) return;
                closed = true;
                peer.uniffiDestroy?.();
                running = false;
                exit.resolve();
              },
            };
          }
          Deferred.doneUnsafe(starting, Exit.void);
          // As makeHelperHost: an agent connection gets the helper's own command, no socket.
          if (helper.direct)
            return {
              socketPath: "",
              pid: HELPER_PID,
              generation: String(starts),
              driverVersion: "0.37.0",
              contractVersion: "",
              mcpProtocolVersion: "",
              mcp: {
                command: helper.bundle.executable,
                args: ["--mcp", "--capability-manifest", helper.capabilityManifestPath],
                environment: [...helper.environment],
              },
            };
          return {
            socketPath: "/tmp/goat-cu-x/driver.sock",
            pid: 777,
            generation: String(starts),
            driverVersion: "0.37.0",
            contractVersion: "0.8.0",
            mcpProtocolVersion: "2025-06-18",
            mcp: {
              command: helper.bundle.driverPath,
              args: ["mcp", "--embedded", "--socket", "/tmp/goat-cu-x/driver.sock"],
              environment: [],
            },
          };
        },
        stop: async () => {
          stops++;
          running = false;
          readinessClient?.uniffiDestroy?.();
          readinessClient = undefined;
          exit.resolve();
        },
        waitForExit: (_generation, operation) => {
          const crash = () => {
            exit.resolve();
            return exit.promise;
          };
          exits.push(crash);
          operation.signal.addEventListener("abort", () => exit.resolve(), { once: true });
          // Await this host's registered exit before detaching, without picking a previous check.
          if (manifest?.scope === "agents") Queue.offerUnsafe(agentMonitors, Effect.promise(crash));
          return exit.promise;
        },
        uniffiDestroy: () => {
          destroys++;
          Queue.offerUnsafe(destroyed, undefined);
        },
      };
    },
    imageHasContent: async () => !options.blankCapture,
    prepareManifest: async (input) => {
      const path = `${input.directory}/${input.scope}.yaml`;
      prepared.set(path, { scope: input.scope, hostBundleIds: input.hostBundleIds });
      const apps =
        input.scope === "agents" ? await (input.listApplications?.() ?? Promise.resolve([])) : [];
      if (input.scope === "agents")
        manifestListings.push({
          scope: input.scope,
          through: input.listApplications ? "helper" : "driver",
          apps: apps.length,
        });
      manifests.set(
        path,
        cuaDriverCapabilityManifest({
          applications: admittedCuaApplications(apps, input.hostBundleIds),
        }),
      );
      return path;
    },
    listApps: async () => listedApps,
    computerUseEnabled: async () => computerUseEnabled,
    readManifest: async (path) => {
      const text = manifests.get(path);
      if (text === undefined) throw new Error("missing manifest");
      return text;
    },
    helperApps: async (bundle) => {
      helperAppListings.push(bundle.bundleId);
      if (appListingFails) throw new Error("driver_untrusted");
      return options.appListing ? options.appListing() : listedApps;
    },
    processId: HOST_PID,
    executablePath: "C:\\Program Files\\GOAT\\GOAT.exe",
    loadElectron: async () => ({
      requestMacOSPermissions: () => ({ accessibility: allowed, screenRecording: allowed }),
      hasRequiredMacOSPermissions: (permissions) =>
        permissions.accessibility && permissions.screenRecording,
    }),
    loadEmbedded: async () => ({
      EmbeddedCuaDriverHost: class {
        static withOptions(options: {
          binaryPath: string;
          hostBundleId: string;
          environment: ReadonlyArray<{ name: string; value: string }>;
          capabilityManifestPath?: string;
          permissionMode?: number;
          approveCapabilityManifest: boolean;
        }) {
          constructors.push({
            path: options.binaryPath,
            bundleId: options.hostBundleId,
            environment: options.environment,
          });
          const manifest = prepared.get(options.capabilityManifestPath ?? "");
          launches.push({
            scope: manifest?.scope ?? "none",
            hostBundleIds: manifest?.hostBundleIds ?? [],
            manifestPath: options.capabilityManifestPath,
            permissionMode: options.permissionMode,
            approved: options.approveCapabilityManifest,
          });
          return new this();
        }
        readonly exit = Promise.withResolvers<{ generation: string; success: boolean }>();
        readonly first = constructors.length === 1;
        async start() {
          starts++;
          Deferred.doneUnsafe(starting, Exit.void);
          if (this.first && options.hold === "start") await gate.promise;
          if (this.first && options.failFirstStart) throw new Error("private native failure");
          if (options.refuseStart)
            throw new Error("embedded cua-driver exited before readiness (code=Some(64))");
          return {
            socketPath: descriptor.socketPath,
            pid: 123,
            generation: String(starts),
            driverVersion: "0.34.1",
            contractVersion: "1",
            mcpProtocolVersion: "1",
            mcp: {
              command: descriptor.command,
              args: descriptor.args,
              environment: descriptor.environment,
            },
          };
        }
        async stop() {
          stops++;
          Deferred.doneUnsafe(stopping, Exit.void);
          if (this.first && options.hold === "stop") await gate.promise;
        }
        waitForExit(generation: string, operation?: { signal: AbortSignal }) {
          const finish = () => this.exit.resolve({ generation, success: false });
          exits.push(finish);
          operation?.signal.addEventListener("abort", finish, { once: true });
          return this.first && holdMonitor
            ? gate.promise.then(() => ({ generation, success: false }))
            : this.exit.promise;
        }
        uniffiDestroy() {
          destroys++;
          Queue.offerUnsafe(destroyed, undefined);
        }
      },
    }),
  };
  const publisher = DesktopTelemetryPublisher.of({
    latest: Effect.succeedNone,
    changes: Stream.empty,
    encoded: Stream.empty,
    encodedForSource: () => Stream.empty,
    handleControlForSource: () => Effect.void,
    removeControlSource: () => Effect.void,
    updateRequests: Stream.empty,
    updateCommits: Stream.empty,
    updateCancellations: Stream.empty,
    publishUpdateReport: () => Effect.void,
    cuaAppsRequests: Stream.fromQueue(appRequests),
    takeCuaAppsRequests: Effect.sync(() => {
      const requestIds = [...pendingAppRequests];
      pendingAppRequests.clear();
      return {
        requestIds,
        publish: (report: DesktopCuaAppsReport) =>
          Queue.offer(appReports, report).pipe(Effect.asVoid),
      };
    }),
    cuaRequests: Stream.fromQueue(requests),
    cuaWatch: Stream.fromQueue(watching),
    cuaWatchApps: Stream.fromQueue(approvals).pipe(
      Stream.flatMap(({ apps, done }) =>
        Stream.concat(
          Stream.make(apps),
          Stream.drain(Stream.fromEffect(Deferred.succeed(done, undefined))),
        ),
      ),
    ),
    publishCuaReport: (report) => Queue.offer(reports, report).pipe(Effect.asVoid),
    publishCuaReadiness: (report) =>
      Effect.sync(() => {
        readiness.push(report);
      }),
    cuaFrames: Stream.empty,
    publishCuaFrame: () => Effect.void,
    publishCuaSafety: (report) =>
      Effect.sync(() => {
        if (report.type === "cuaPrivateMode") safety.push(report);
      }).pipe(Effect.andThen(Queue.offer(safetyHeard, undefined)), Effect.asVoid),
  });
  const environment = DesktopEnvironment.layer({
    dirname: "/app",
    homeDirectory: "/home/test",
    platform: options.platform ?? "linux",
    processArch: "x64",
    appVersion: "1.0.0",
    appPath: "/app",
    isPackaged: options.isPackaged ?? true,
    resourcesPath: "/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodePath.layerPosix,
        DesktopConfig.layerTest({ GOAT_DESKTOP_APP_USER_MODEL_ID: "codes.t3.host-test" }),
      ),
    ),
  );
  const driver = yield* make(dependencies).pipe(
    Effect.provideService(DesktopTelemetryPublisher, options.publisher ?? publisher),
    Effect.provide(environment),
  );
  yield* driver.listen;
  return {
    requestApps: (requestId: string) =>
      Effect.sync(() => {
        pendingAppRequests.add(requestId);
      }).pipe(Effect.andThen(Queue.offer(appRequests, undefined))),
    nextApps: Queue.take(appReports),
    setComputerUseEnabled: (enabled: boolean) =>
      Effect.sync(() => {
        computerUseEnabled = enabled;
      }),
    manifest: () => manifests.get(launches.at(-1)?.manifestPath ?? "") ?? "",
    failAppListing: Effect.sync(() => {
      appListingFails = true;
    }),
    listApps: (apps: ReadonlyArray<CuaDriverListedApp>) =>
      Effect.sync(() => {
        listedApps = apps;
      }),
    approveApps: (apps: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        yield* Queue.offer(approvals, { apps, done });
        yield* Deferred.await(done);
      }),
    restart: driver.restart,
    verify: driver.verify,
    grants: driver.grants,
    toolCalls,
    clientsOpen: () => clientsOpen,
    socketConnections: () => socketConnections,
    request: (requestId: string, enabled = true) =>
      Queue.offer(requests, { version: 1, type: "cuaDriverRequest", requestId, enabled }),
    next: Queue.take(reports),
    pendingReports: Queue.size(reports),
    starting: Deferred.await(starting),
    stopping: Deferred.await(stopping),
    destroyed: Queue.take(destroyed),
    nextAgentCrash: Queue.take(agentMonitors),
    release: Effect.sync(() => gate.resolve()),
    grantPermissions: Effect.sync(() => {
      allowed = true;
    }),
    denyPermissions: Effect.sync(() => {
      allowed = false;
    }),
    /** What the helper answers to its next grant check. */
    answerAsHelper: (answer: HelperAnswer) =>
      Effect.sync(() => {
        helperAnswer = answer;
      }),
    /** The shipped helper can no longer be used (its bundle lost its permissions) or is gone. */
    loseHelper: (how: "unusable" | "absent") =>
      Effect.sync(() => {
        helperLost = how;
      }),
    restoreHelper: Effect.sync(() => {
      helperLost = undefined;
    }),
    crash: Effect.sync(() => exits.at(-1)?.()),
    constructors,
    launches,
    helperProbes,
    manifestListings,
    helperAppListings,
    helperLaunches,
    readiness,
    /** The server says whether agents control the host. */
    applyHelperUpdate: Effect.sync(() => {
      updatedHelper = true;
    }),
    setWatching: (active: boolean) => Queue.offer(watching, active).pipe(Effect.asVoid),
    nextHelperWatch: Queue.take(helperWatches),
    raisePrivateMode: (active: boolean, windowId: number) =>
      Effect.sync(() => raise?.(active, windowId)),
    safety,
    nextSafety: Queue.take(safetyHeard),
    counts: () => ({ starts, stops, destroys }),
  };
});

export const VERIFICATION_IDS = [
  "grants",
  "restart",
  "permissions",
  "identity",
  "capture",
  "accessibility",
] as const;

/** A healthy driver whose health report names the helper bundle and its parent process. */
export const helperTools = (identity: { bundle: string; parent: number }) => ({
  ...healthyTools(),
  health_report: toolResult({
    checks: [
      {
        name: "bundle_identity",
        status: "pass",
        data: {
          bundle_identifier: identity.bundle,
          identity_source: "parent_application",
          parent_process_id: identity.parent,
        },
      },
    ],
  }),
});
