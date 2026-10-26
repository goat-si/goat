import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DeviceHostUnavailableError,
  DeviceId,
  type DeviceSummary,
  EnvironmentId,
  type Project,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment-device-test");
const threadId = ThreadId.make("thread-device-test");
const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId,
  requestNamespace: "provider-session-device-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-device-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const device = {
  hostId: "local",
  id: "UDID-1",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};
const state = {
  hosts: [
    {
      id: "local",
      kind: "local" as const,
      label: "This machine",
      platforms: [
        { platform: "ios" as const, available: true },
        { platform: "android" as const, available: false, reason: "No SDK" },
      ],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready" as const,
  hostStatuses: { local: { status: "ready" as const } },
  devices: [device],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
const png = new Uint8Array(24);
new DataView(png.buffer).setUint32(0, 0x89504e47);
new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
new DataView(png.buffer).setUint32(12, 0x49484452);
new DataView(png.buffer).setUint32(16, 1206);
new DataView(png.buffer).setUint32(20, 2622);

const unused = Effect.die("not used");
const readiness = {
  hostId: "local",
  nodePath: process.execPath,
  hub: { origin: "http://hub.test" },
  devices: {
    list: unused,
    boot: () => unused,
    attach: () => unused,
    shutdown: () => unused,
    screenshot: () => unused,
  },
  run: () => unused,
  helpers: { serveSimAxSettings: null, serveSimCli: null },
  agentDevice: null,
};
// The thread's project exists and Agent device access is on.
const layerProjectAccess = Layer.mock(ProjectService.ProjectService)({
  getById: (id) =>
    Effect.succeed(
      Option.some({
        id,
        title: "Device test project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      } as Project),
    ),
}).pipe(Layer.merge(ServerSettings.layerTest({ enableAgentDeviceAccess: true })));

const layerDeviceServiceMock = (
  opened: Array<unknown> = [],
  target: DeviceSummary = device,
  bootedTarget = target,
) => {
  const observed = Effect.sync(() => ({
    ...state,
    devices: [opened.length > 0 ? bootedTarget : target, { ...target, id: "UDID-2" }],
  }));
  return Layer.mock(DeviceService.DeviceService)({
    state: observed,
    list: observed,
    agentReadinessIfSupported: () => Effect.succeed(readiness),
    open: (input) =>
      Effect.sync(() => {
        opened.push(input);
        return {
          threadId: input.threadId,
          hostId: "local",
          deviceId: bootedTarget.id,
          platform: bootedTarget.platform,
          openedAt: "2026-09-08T00:00:00.000Z",
        };
      }),

    sessionsForThread: (id) =>
      Effect.succeed(
        id === threadId
          ? [
              {
                threadId,
                hostId: "local",
                deviceId: DeviceId.make("UDID-1"),
                platform: "ios" as const,
                openedAt: "2026-09-08T00:00:00.000Z",
              },
            ]
          : [],
      ),
    screenshot: () => Effect.succeed({ device, png }),
    close: () => Effect.void,
    agentCli: Effect.succeed("/cli"),
    testHost: () => Effect.die("not used"),
    // As for an EAS device, agent-device knows the device by a different id than T3.
    agentTarget: () =>
      Effect.succeed({
        agentDeviceId: "SIM-UDID",
        args: ["--config", "/host.json", "--session", "thread-device"],
      }),
  });
};

const layerTest = (opened?: Array<unknown>, target?: DeviceSummary, bootedTarget?: DeviceSummary) =>
  McpHttpServer.layerDeviceToolkit.pipe(
    Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(layerDeviceServiceMock(opened, target, bootedTarget)),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(layerProjectAccess),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-mcp-device-toolkit-test-" }),
    ),
    Layer.provide(NodeServices.layer),
  );

it.effect("registers the device tools and returns the screenshot as image content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name).toSorted();
      expect(names).toEqual([
        "goat_device_close",
        "goat_device_list",
        "goat_device_open",
        "goat_device_screenshot",
      ]);

      const callWith = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities));

      const opened = yield* server
        .callTool({ name: "goat_device_open", arguments: { platform: "ios" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(opened.isError).toBe(false);
      const openedContent = opened.structuredContent as { quickStart: string };
      expect(openedContent.quickStart).toContain("--udid SIM-UDID");

      const shot = yield* server
        .callTool({ name: "goat_device_screenshot", arguments: { deviceId: "UDID-1" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(shot.isError).toBe(false);
      expect(shot.content.map((entry) => entry.type)).toEqual(["text", "image"]);
      expect(shot.structuredContent).toBeUndefined();
      const [shotText] = shot.content;
      expect(shotText?.type === "text" ? JSON.parse(shotText.text) : null).toMatchObject({
        screenshot: { mimeType: "image/png", width: 1206, height: 2622 },
      });

      const foreign = yield* server
        .callTool({ name: "goat_device_screenshot", arguments: { deviceId: "UDID-2" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(foreign.isError).toBe(true);
      expect(foreign.content.map((entry) => entry.type)).toEqual(["text"]);

      const denied = yield* server
        .callTool({ name: "goat_device_list", arguments: {} })
        .pipe(callWith(["preview"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toContain("Settings → Integrations → Devices");
    }),
  ).pipe(Effect.provide(layerTest())),
);

it.effect("tells an outside client why a screenshot was refused, not only that it failed", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const refused = yield* server
      .callTool({ name: "goat_device_screenshot", arguments: { deviceId: "UDID-1" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation(["device"]),
          thread: undefined,
          client: { sessionId: "outside", label: "Outside agent", access: "full-access" },
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(refused.isError).toBe(true);
    const text = refused.content[0]?.type === "text" ? refused.content[0].text : "";
    // Text-only clients such as Pi see just this block, so it carries the code as well.
    const refusal = JSON.parse(text) as { readonly code: string; readonly message: string };
    expect(refusal).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "thread_credential_required",
    });
    expect(refusal.message).toContain("calling GOAT thread");
    expect(refused.structuredContent).toEqual({
      error: {
        _tag: "OrchestratorMcpFailure",
        operation: "screenshot",
        failureCount: 1,
        code: "thread_credential_required",
        message: refusal.message,
      },
    });
  }).pipe(Effect.scoped, Effect.provide(layerTest())),
);

it.effect("rejects unavailable agent access before booting or opening a device", () => {
  const layerUnavailable = Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed(state),
    agentReadinessIfSupported: () =>
      Effect.fail(
        new DeviceHostUnavailableError({ hostId: "local", reason: "Agent access is disabled." }),
      ),
    open: () => Effect.die("Must not boot or register a device when agent access fails"),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "goat_device_open", arguments: { platform: "ios" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Agent access is disabled."),
        }),
      ]),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(layerUnavailable),
        Layer.provide(layerProjectAccess),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "goat-mcp-device-toolkit-test-" }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

it.effect("opens one device on a keyed retry and rechecks device access before replay", () => {
  const opened: Array<unknown> = [];
  const open = (
    clientRequestId: string | undefined,
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["device"],
    deviceId = "UDID-1",
  ) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) =>
        server.callTool({
          name: "goat_device_open",
          arguments: { deviceId, clientRequestId },
        }),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  return Effect.gen(function* () {
    const first = yield* open("device-1");
    expect(first.isError, JSON.stringify(first)).toBe(false);
    expect(yield* open("device-1")).toEqual(first);
    expect(opened).toHaveLength(1);
    expect(opened[0]).not.toHaveProperty("clientRequestId");
    expect((yield* open("device-1", [])).isError).toBe(true);
    const mismatch = yield* open("device-1", ["device"], "UDID-2");
    expect(mismatch.isError).toBe(true);
    expect(mismatch.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining('"reason":"idempotency_mismatch"'),
        }),
      ]),
    );
    expect(opened).toHaveLength(1);
    yield* open("device-2");
    yield* open(undefined);
    expect(opened).toHaveLength(3);
  }).pipe(Effect.provide(layerTest(opened)));
});

it.effect("replays an Android device open after boot changes its discovered id", () => {
  const opened: Array<unknown> = [];
  const target: DeviceSummary = { ...device, id: "test-avd", platform: "android", booted: false };
  const bootedTarget = { ...target, id: "emulator-5554", booted: true };
  const open = McpServer.McpServer.pipe(
    Effect.flatMap((server) =>
      server.callTool({
        name: "goat_device_open",
        arguments: { deviceId: "test-avd", clientRequestId: "android-open" },
      }),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
    Effect.provideService(McpSchema.McpServerClient, client),
  );
  return Effect.gen(function* () {
    const first = yield* open;
    expect(first.isError, JSON.stringify(first)).toBe(false);
    expect(first.structuredContent).toMatchObject({ device: { id: "emulator-5554" } });
    expect(yield* open).toEqual(first);
    expect(opened).toHaveLength(1);
  }).pipe(Effect.provide(layerTest(opened, target, bootedTarget)));
});
