import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import type { DesktopCuaDriverReport, DesktopCuaDriverRequest } from "@goat/contracts";
import type { ToolResult } from "@trycua/cua-driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { DesktopTelemetryPublisher } from "../telemetry/DesktopTelemetryPublisher.ts";
import { bitmapHasContent, make, type DesktopCuaDriverDependencies } from "./DesktopCuaDriver.ts";

// The embedded allowlist forwards only these opt-outs; DO_NOT_TRACK would fail construction.
const privacyEnvironment = [
  { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" },
  { name: "CUA_TELEMETRY_ENABLED", value: "false" },
  { name: "CUA_DRIVER_RS_UPDATE_CHECK", value: "false" },
];

const descriptor = {
  command: "/native/driver",
  args: ["mcp", "--session", "opaque-session"],
  environment: [{ name: "CUA_SESSION", value: "private-session-token" }],
  socketPath: "/private/driver.sock",
};

const HOST_PID = 4242;

const toolResult = (structured: unknown, images: ToolResult["images"] = []): ToolResult => ({
  text: "",
  images,
  structuredJson: JSON.stringify(structured),
  isError: false,
  degraded: false,
  rawJson: "{}",
});

// Shapes recorded from the pinned 0.37.0 daemon, trimmed to the fields the verifier reads.
const healthyTools = (): Record<string, ToolResult> => ({
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

const fixture = Effect.fn(function* (
  options: {
    platform?: NodeJS.Platform;
    isPackaged?: boolean;
    denyPermissions?: boolean;
    failFirstStart?: boolean;
    hold?: "start" | "stop" | "monitor";
    tools?: Record<string, ToolResult>;
    blankCapture?: boolean;
    refuseStart?: boolean;
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
    imageHasContent: async () => !options.blankCapture,
    prepareManifest: async (input) => {
      const path = `${input.directory}/${input.scope}.yaml`;
      prepared.set(path, { scope: input.scope, hostBundleIds: input.hostBundleIds });
      return path;
    },
    processId: HOST_PID,
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
    crash: Effect.sync(() => exits.at(-1)!()),
    constructors,
    launches,
    counts: () => ({ starts, stops, destroys }),
  };
});

afterEach(() => vi.unstubAllEnvs());

describe("DesktopCuaDriver", () => {
  it.effect("hosts with the app identity, preserves the descriptor, reuses and releases once", () =>
    Effect.gen(function* () {
      vi.stubEnv("GOAT_CUA_DRIVER_PATH", "/ignored-in-packaged-app");
      const test = yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture();
          yield* test.request("first");
          assert.deepEqual(yield* test.next, {
            version: 1,
            type: "cuaDriverReport",
            requestId: "first",
            status: "ready",
            mcp: descriptor,
          });
          assert.deepEqual(test.constructors, [
            {
              path: "/resources/cua-driver/cua-driver",
              bundleId: "codes.t3.host-test",
              environment: privacyEnvironment,
            },
          ]);
          yield* test.request("reuse");
          assert.deepEqual(yield* test.next, {
            version: 1,
            type: "cuaDriverReport",
            requestId: "reuse",
            status: "ready",
            mcp: descriptor,
          });
          yield* test.request("disable", false);
          assert.equal((yield* test.next).status, "stopped");
          yield* test.request("disable-again", false);
          assert.equal((yield* test.next).status, "stopped");
          assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
          yield* test.request("new-session");
          assert.equal((yield* test.next).status, "ready");
          return test;
        }),
      );
      assert.deepEqual(test.counts(), { starts: 2, stops: 2, destroys: 2 });
    }),
  );

  it.effect("requires a development override and uses it to host without a bundled driver", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubEnv("GOAT_CUA_DRIVER_PATH", " ");
        const missing = yield* fixture({ isPackaged: false });
        yield* missing.request("unconfigured");
        assert.equal((yield* missing.next).status, "unavailable");
        assert.isEmpty(missing.constructors);

        vi.stubEnv("GOAT_CUA_DRIVER_PATH", " /dev/cua-driver ");
        const configured = yield* fixture({ isPackaged: false });
        yield* configured.request("configured");
        assert.equal((yield* configured.next).status, "ready");
        assert.deepEqual(configured.constructors, [
          {
            path: "/dev/cua-driver",
            bundleId: "codes.t3.host-test",
            environment: privacyEnvironment,
          },
        ]);
      }),
    ),
  );

  it.effect("denies missing macOS permissions and restarts the host after permission changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", denyPermissions: true });
        yield* test.request("denied");
        const denied = yield* test.next;
        assert.equal(denied.status, "unavailable");
        if (denied.status !== "ready")
          assert.match(denied.message ?? "", /Accessibility|Screen Recording/);
        assert.isEmpty(test.constructors);
        yield* test.grantPermissions;
        yield* test.restart;
        yield* test.request("granted");
        assert.equal((yield* test.next).status, "ready");
        assert.equal(test.constructors[0]?.path, "/resources/cua-driver");
        yield* test.restart;
        assert.deepEqual(yield* test.next, {
          version: 1,
          type: "cuaDriverReport",
          requestId: "granted",
          status: "stopped",
        });
        yield* test.request("fresh-permissions");
        assert.equal((yield* test.next).status, "ready");
        assert.deepEqual(test.counts(), { starts: 2, stops: 1, destroys: 1 });
      }),
    ),
  );

  it.effect(
    "releases failed starts and crashed hosts, correlates failure, and permits recovery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ failFirstStart: true });
          yield* test.request("failed-start");
          const failed = yield* test.next;
          assert.equal(failed.status, "unavailable");
          assert.equal(failed.requestId, "failed-start");
          assert.notInclude(JSON.stringify(failed), "private native failure");
          assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
          yield* test.request("recover");
          assert.equal((yield* test.next).status, "ready");
          yield* test.request("current-request");
          yield* test.next;
          yield* test.crash;
          const crashed = yield* test.next;
          assert.equal(crashed.status, "unavailable");
          assert.equal(crashed.requestId, "current-request");
          assert.deepEqual(test.counts(), { starts: 2, stops: 2, destroys: 2 });
          yield* test.request("after-crash");
          assert.equal((yield* test.next).status, "ready");
          assert.lengthOf(test.constructors, 3);
        }),
      ),
  );

  it.effect(
    "retains a timed-out native start through bounded shutdown and releases its late result",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const test = yield* fixture({ hold: "start" }).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        yield* test.request("pending-start");
        yield* test.starting;
        yield* TestClock.adjust("23 seconds");
        assert.equal((yield* test.next).status, "unavailable");
        yield* test.request("cannot-replace");
        assert.equal((yield* test.next).status, "unavailable");
        assert.lengthOf(test.constructors, 1);
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
        yield* TestClock.adjust("3 seconds");
        yield* Fiber.join(closing);
        assert.deepEqual(test.counts(), { starts: 1, stops: 0, destroys: 0 });
        yield* test.release;
        yield* test.destroyed;
        assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
        assert.equal(yield* test.pendingReports, 0);
      }),
  );

  it.effect.each(["stop", "monitor"] as const)(
    "bounds restart but retains ownership until the native %s settles",
    (hold) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ hold });
          yield* test.request("active");
          assert.equal((yield* test.next).status, "ready");
          const restarting = yield* test.restart.pipe(Effect.forkChild);
          yield* test.stopping;
          yield* TestClock.adjust("3 seconds");
          yield* Fiber.join(restarting);
          const report = yield* test.next;
          assert.equal(report.requestId, "active");
          assert.equal(report.status, "unavailable");
          yield* test.request("cannot-replace");
          assert.equal((yield* test.next).status, "unavailable");
          assert.lengthOf(test.constructors, 1);
          assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 0 });
          yield* test.release;
          yield* test.destroyed;
          yield* test.request("after-settlement");
          assert.equal((yield* test.next).status, "ready");
          assert.deepEqual(test.counts(), { starts: 2, stops: 1, destroys: 1 });
        }),
      ),
  );
});

const VERIFICATION_IDS = [
  "grants",
  "restart",
  "permissions",
  "identity",
  "capture",
  "accessibility",
] as const;

describe("DesktopCuaDriver verification", () => {
  it.effect("gives agents the general manifest and the grant check one that admits only GOAT", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin" });
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        assert.isTrue((yield* test.verify).verified);
        assert.deepEqual(test.launches, [
          {
            scope: "agents",
            hostBundleIds: ["codes.t3.host-test"],
            manifestPath: "/home/test/.goat/desktop/userdata/cua-driver/agents.yaml",
            permissionMode: 0,
            approved: true,
          },
          {
            scope: "verify",
            hostBundleIds: ["codes.t3.host-test"],
            manifestPath: "/home/test/.goat/desktop/userdata/cua-driver/verify.yaml",
            permissionMode: 0,
            approved: true,
          },
        ]);
      }),
    ),
  );

  it.effect("names a refused manifest instead of a generic failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ refuseStart: true });
        yield* test.request("refused");
        const report = yield* test.next;
        assert.equal(report.status, "unavailable");
        assert.match(
          report.status === "unavailable" ? (report.message ?? "") : "",
          /refused GOAT's capability manifest/,
        );
      }),
    ),
  );

  it.effect("verifies only after a restarted driver reads and captures a GOAT window", () =>
    Effect.gen(function* () {
      const test = yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ platform: "darwin" });
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          assert.deepEqual(yield* test.verify, {
            verified: true,
            steps: VERIFICATION_IDS.map((id) => ({ id, ok: true })),
          });
          // The agent's driver predates the grants; its session must reconnect to a fresh one.
          assert.deepEqual(yield* test.next, {
            version: 1,
            type: "cuaDriverReport",
            requestId: "agent",
            status: "stopped",
          });
          assert.deepEqual(test.toolCalls, [
            { name: "check_permissions", input: {} },
            { name: "health_report", input: { include: ["bundle_identity"] } },
            { name: "list_windows", input: { pid: HOST_PID, on_screen_only: true } },
            { name: "get_window_state", input: { pid: HOST_PID, window_id: 77 } },
          ]);
          // The check's own driver is retired, so nothing runs until the next agent session.
          assert.deepEqual(test.counts(), { starts: 2, stops: 2, destroys: 2 });
          assert.equal(test.clientsOpen(), 0);
          yield* test.request("next-session");
          assert.equal((yield* test.next).status, "ready");
          return test;
        }),
      );
      assert.deepEqual(test.counts(), { starts: 3, stops: 3, destroys: 3 });
    }),
  );

  const failures: ReadonlyArray<{
    readonly name: string;
    readonly options: Parameters<typeof fixture>[0];
    readonly failedAt: (typeof VERIFICATION_IDS)[number];
    readonly detail: RegExp;
  }> = [
    {
      name: "Electron reports a missing grant",
      options: { denyPermissions: true },
      failedAt: "grants",
      detail: /^Accessibility and Screen Recording are off for GOAT\.$/,
    },
    {
      name: "the driver answers for itself instead of GOAT",
      options: {
        tools: {
          ...healthyTools(),
          check_permissions: toolResult({
            accessibility: true,
            screen_recording: true,
            source: { attribution: "caller" },
          }),
        },
      },
      failedAt: "permissions",
      detail: /not running under GOAT's permissions/,
    },
    {
      name: "the restarted driver still sees a denied grant",
      options: {
        tools: {
          ...healthyTools(),
          check_permissions: toolResult({
            accessibility: true,
            screen_recording: false,
            source: { attribution: "host" },
          }),
        },
      },
      failedAt: "permissions",
      detail: /does not see Screen Recording/,
    },
    {
      name: "the parent is not an identifiable app",
      options: {
        tools: {
          ...healthyTools(),
          health_report: toolResult({
            checks: [
              {
                name: "bundle_identity",
                status: "fail",
                message:
                  "Embedded mode is set, but the parent process is not an identifiable macOS application.",
                data: { identity_source: "parent_application", parent_process_id: HOST_PID },
              },
            ],
          }),
        },
      },
      failedAt: "identity",
      detail: /not an identifiable macOS application/,
    },
    {
      name: "no GOAT window is on screen",
      options: { tools: { ...healthyTools(), list_windows: toolResult({ windows: [] }) } },
      failedAt: "capture",
      detail: /Keep a GOAT window open/,
    },
    {
      name: "the screen is locked",
      options: {
        tools: {
          ...healthyTools(),
          get_window_state: toolResult({
            degraded: true,
            degraded_reason:
              "screen_locked: window_id 77 has no accessibility tree because the screen is locked.",
            element_count: 0,
          }),
        },
      },
      failedAt: "capture",
      detail: /screen is locked/,
    },
    {
      name: "the capture is blank",
      options: { blankCapture: true },
      failedAt: "capture",
      detail: /screenshot was blank/,
    },
    {
      name: "the window has no accessibility tree",
      options: {
        tools: {
          ...healthyTools(),
          get_window_state: toolResult({ element_count: 0 }, [
            { mimeType: "image/png", dataBase64: "cGl4ZWxz" },
          ]),
        },
      },
      failedAt: "accessibility",
      detail: /could not read GOAT's window/,
    },
  ];

  it.effect.each(failures)("stops at $failedAt when $name", (failure) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", ...failure.options });
        const result = yield* test.verify;
        const index = VERIFICATION_IDS.indexOf(failure.failedAt);
        assert.isFalse(result.verified);
        assert.deepEqual(
          result.steps.map((step) => [step.id, step.ok]),
          VERIFICATION_IDS.slice(0, index + 1).map((id) => [id, id !== failure.failedAt]),
        );
        assert.match(result.steps.at(-1)?.detail ?? "", failure.detail);
        // A failed check never leaves its driver or SDK client running.
        assert.equal(test.counts().starts, test.counts().destroys);
        assert.equal(test.clientsOpen(), 0);
      }),
    ),
  );

  it.effect("an early failure leaves the agent's running driver alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin" });
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        // Grants revoked after the driver started: the check stops before its own restart.
        yield* test.denyPermissions;
        const result = yield* test.verify;
        assert.deepEqual(
          result.steps.map((step) => [step.id, step.ok]),
          [["grants", false]],
        );
        // Stopping it here would leave the server holding a dead descriptor it was never told about.
        assert.deepEqual(test.counts(), { starts: 1, stops: 0, destroys: 0 });
        assert.equal(yield* test.pendingReports, 0);
        yield* test.request("reuse");
        assert.equal((yield* test.next).status, "ready");
        assert.equal(test.counts().starts, 1);
      }),
    ),
  );

  it.effect("reports that only macOS has grants to verify", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "linux" });
        assert.deepEqual(yield* test.verify, {
          verified: false,
          steps: [{ id: "grants", ok: false, detail: "Permission checks run on macOS only." }],
        });
        assert.isEmpty(test.constructors);
      }),
    ),
  );

  it("treats an all-black capture as blank and any visible content as captured", () => {
    const black = new Uint8Array(64 * 64 * 4);
    assert.isFalse(bitmapHasContent(black));
    assert.isFalse(bitmapHasContent(new Uint8Array()));
    const content = black.slice();
    for (let offset = 0; offset < content.length; offset += 4 * 20) content[offset + 1] = 200;
    assert.isTrue(bitmapHasContent(content));
  });
});
