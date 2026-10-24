// Shared fixture for the DesktopCuaDriver suites; one fake per native dependency.
import * as NodePath from "@effect/platform-node/NodePath";
import type { DesktopCuaDriverReport, DesktopCuaDriverRequest } from "@goat/contracts";
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
    blankCapture?: boolean;
    refuseStart?: boolean;
    /** Ship the GOAT Computer Use helper; its grants are separate from Electron's. */
    helper?: { readonly granted: boolean; readonly detail?: string } | "unusable";
    /** The helper refuses to list apps, as it does for a driver that fails its seal check. */
    helperAppsFail?: boolean;
  } = {},
) {
  const requests = yield* Queue.unbounded<DesktopCuaDriverRequest>();
  const reports = yield* Queue.unbounded<DesktopCuaDriverReport>();
  const starting = yield* Deferred.make<void>();
  const stopping = yield* Deferred.make<void>();
  const destroyed = yield* Queue.unbounded<void>();
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
  let starts = 0;
  let stops = 0;
  let destroys = 0;
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  let clientsOpen = 0;
  const helperProbes: Array<{ bundleId: string; prompt: boolean }> = [];
  /** How each manifest got its app list: through the helper, or by running the driver here. */
  const manifestListings: Array<{ scope: string; through: "helper" | "driver"; apps: number }> = [];
  const helperAppListings: string[] = [];
  const helperLaunches: Array<{
    bundleId: string;
    driverPath: string;
    manifestPath: string;
    environment: ReadonlyArray<{ name: string; value: string }>;
  }> = [];
  const dependencies: DesktopCuaDriverDependencies = {
    connect: async () => {
      clientsOpen++;
      return {
        callTool: async (name, input) => {
          toolCalls.push({ name, input: JSON.parse(input) });
          const result = (options.tools ?? healthyTools())[name];
          if (!result) throw new Error(`unexpected tool ${name}`);
          return result;
        },
        uniffiDestroy: () => {
          clientsOpen--;
        },
      };
    },
    checkGrants: async () => ({ accessibility: allowed, screenRecording: allowed }),
    helperGrants: async (bundle, prompt) => {
      helperProbes.push({ bundleId: bundle.bundleId, prompt });
      const helper = typeof options.helper === "object" ? options.helper : undefined;
      const granted = helper?.granted ?? false;
      return helper?.detail === undefined
        ? { accessibility: granted, screenRecording: granted }
        : { accessibility: granted, screenRecording: granted, detail: helper.detail };
    },
    helperBundlePath: async () =>
      options.helper === "unusable"
        ? { kind: "unusable", message: "GOAT Computer Use at /Helpers cannot be used (EACCES)." }
        : options.helper
          ? { kind: "found", path: HELPER_BUNDLE }
          : { kind: "absent" },
    helperHost: (helper) => {
      helperLaunches.push({
        bundleId: helper.bundle.bundleId,
        driverPath: helper.bundle.driverPath,
        manifestPath: helper.capabilityManifestPath,
        environment: helper.environment,
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
      return {
        servicePid: () => (running ? HELPER_PID : undefined),
        start: async () => {
          starts++;
          running = true;
          Deferred.doneUnsafe(starting, Exit.void);
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
          exit.resolve();
        },
        waitForExit: (_generation, operation) => {
          exits.push(() => exit.resolve());
          operation.signal.addEventListener("abort", () => exit.resolve(), { once: true });
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
      if (input.scope === "agents")
        manifestListings.push(
          input.listApplications
            ? {
                scope: input.scope,
                through: "helper",
                apps: (await input.listApplications()).length,
              }
            : { scope: input.scope, through: "driver", apps: 0 },
        );
      return path;
    },
    helperApps: async (bundle) => {
      helperAppListings.push(bundle.bundleId);
      if (options.helperAppsFail) throw new Error("driver_untrusted");
      return [{ bundle_id: "com.apple.TextEdit", name: "TextEdit" }];
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
    cuaRequests: Stream.fromQueue(requests),
    cuaWatch: Stream.empty,
    publishCuaReport: (report) => Queue.offer(reports, report).pipe(Effect.asVoid),
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
    Effect.provideService(DesktopTelemetryPublisher, publisher),
    Effect.provide(environment),
  );
  yield* driver.listen;
  return {
    restart: driver.restart,
    verify: driver.verify,
    toolCalls,
    clientsOpen: () => clientsOpen,
    request: (requestId: string, enabled = true) =>
      Queue.offer(requests, { version: 1, type: "cuaDriverRequest", requestId, enabled }),
    next: Queue.take(reports),
    pendingReports: Queue.size(reports),
    starting: Deferred.await(starting),
    stopping: Deferred.await(stopping),
    destroyed: Queue.take(destroyed),
    release: Effect.sync(() => gate.resolve()),
    grantPermissions: Effect.sync(() => {
      allowed = true;
    }),
    denyPermissions: Effect.sync(() => {
      allowed = false;
    }),
    crash: Effect.sync(() => exits.at(-1)?.()),
    constructors,
    launches,
    helperProbes,
    manifestListings,
    helperAppListings,
    helperLaunches,
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
