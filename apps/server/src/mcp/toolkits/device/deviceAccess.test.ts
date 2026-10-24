import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DeviceId,
  EnvironmentId,
  LOCAL_DEVICE_HOST_ID,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import type * as DeviceHost from "../../../device/DeviceHost.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { AGENT_DEVICE_ACCESS_OFF } from "../../toolAvailability.ts";

const granted = ProjectId.make("project:granted");
const other = ProjectId.make("project:other");
const deleted = ProjectId.make("project:deleted");
const threads = {
  granted: ThreadId.make("thread:granted"),
  other: ThreadId.make("thread:other"),
  orphaned: ThreadId.make("thread:orphaned"),
  missing: ThreadId.make("thread:missing"),
};
const projectOf = new Map([
  [threads.granted, granted],
  [threads.other, other],
  [threads.orphaned, deleted],
]);

const simulator = {
  id: DeviceId.make("SIM-1"),
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};

// A local iOS host that records when agent tools start and when a device is attached.
const makeDeviceService = (activity: Array<string>) =>
  Effect.gen(function* () {
    const ready: DeviceHost.DeviceHostReady = {
      nodePath: process.execPath,
      hub: { origin: "http://device.test" },
      devices: {
        list: Effect.succeed({ devices: [simulator], detail: undefined }),
        boot: () => Effect.die("The simulator is already booted"),
        attach: () => Effect.sync(() => void activity.push("attach")),
        shutdown: () => Effect.void,
        screenshot: () => Effect.succeed(new Uint8Array(24)),
      },
      run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    };
    const host: DeviceHost.DeviceHost["Service"] = {
      id: LOCAL_DEVICE_HOST_ID,
      label: "This machine",
      summary: Effect.succeed({
        id: LOCAL_DEVICE_HOST_ID,
        kind: "local",
        label: "This machine",
        platforms: [{ platform: "ios", available: true }],
        hubInstalled: true,
        agentDeviceInstalled: true,
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
      ensureReady: () => Effect.succeed(ready),
      ensureAgentReady: () =>
        Effect.sync(() => {
          activity.push("agent");
          return {
            ...ready,
            agentDevice: { baseUrl: "http://agent.test", token: "test", entryPath: "/agent" },
          };
        }),
      current: Effect.succeed(ready),
      stopAgent: Effect.void,
      stop: Effect.void,
    };
    const service = yield* DeviceService.makeWithHosts(new Map([[host.id, host]]), undefined, () =>
      Effect.succeed("/host.json"),
    );
    return { ...service, agentCli: Effect.succeed("/agent-device") };
  });

const threadsLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) => {
    const projectId = projectOf.get(threadId);
    return Effect.succeed(
      projectId === undefined
        ? null
        : { ...McpToolAccessTestkit.liveThreadShell(threadId), projectId },
    );
  },
});

const projectsLayer = Layer.mock(ProjectService.ProjectService)({
  getById: (projectId) =>
    Effect.succeed(
      projectId === deleted
        ? Option.none()
        : Option.some({
            id: projectId,
            title: projectId,
            workspaceRoot: process.cwd(),
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          } as Project),
    ),
});

const layer = (settings: Parameters<typeof ServerSettings.layerTest>[0], activity: Array<string>) =>
  McpHttpServer.layerDeviceToolkit.pipe(
    Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(threadsLayer),
    Layer.provideMerge(Layer.effect(DeviceService.DeviceService, makeDeviceService(activity))),
    Layer.provideMerge(ServerSettings.layerTest(settings)),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(projectsLayer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-device-access-test-" })),
    Layer.provide(NodeServices.layer),
  );

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

// Every call carries a credential issued with device access; only the settings change.
const call = (threadId: ThreadId, name: string, args: Record<string, unknown> = {}) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-device-access-test"),
      requestNamespace: `provider-session:${threadId}`,
      thread: {
        threadId,
        providerSessionId: `provider-session:${threadId}`,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set<McpInvocationContext.McpCapability>(["device"]),
      issuedAt: 1,
    }),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const refusal = (result: {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<unknown>;
}) => (result.isError === true ? JSON.stringify(result.content) : "not refused");

describe("device tools authorize the calling thread's project at each call", () => {
  it.effect(
    "a project grant reaches only its own threads while the environment default is off",
    () => {
      const activity: Array<string> = [];
      return Effect.gen(function* () {
        const opened = yield* call(threads.granted, "goat_device_open", { platform: "ios" });
        expect(opened.isError, JSON.stringify(opened.content)).toBe(false);
        expect((opened.structuredContent as { quickStart: string }).quickStart).toContain(
          "--config /host.json",
        );
        expect(activity).toEqual(["agent", "attach", "agent"]);

        for (const threadId of [threads.other, threads.orphaned, threads.missing]) {
          expect(refusal(yield* call(threadId, "goat_device_open", { platform: "ios" }))).toContain(
            AGENT_DEVICE_ACCESS_OFF,
          );
        }
        expect(activity).toEqual(["agent", "attach", "agent"]);
      }).pipe(
        Effect.provide(
          layer(
            {
              enableDeviceSupport: true,
              enableAgentDeviceAccess: false,
              projectSettingsOverrides: { [granted]: { enableAgentDeviceAccess: true } },
            },
            activity,
          ),
        ),
      );
    },
  );

  it.effect("access changed after the credential was issued applies to the next call", () => {
    const activity: Array<string> = [];
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const opened = yield* call(threads.granted, "goat_device_open", { deviceId: "SIM-1" });
      expect(opened.isError, JSON.stringify(opened.content)).toBe(false);

      yield* settings.updateSettings({
        projectSettingsOverrides: { [granted]: { enableAgentDeviceAccess: false } },
      });
      const before = [...activity];
      for (const [name, args] of [
        ["goat_device_screenshot", { deviceId: "SIM-1" }],
        ["goat_device_list", {}],
        ["goat_device_open", { deviceId: "SIM-1" }],
      ] as const) {
        expect(refusal(yield* call(threads.granted, name, args))).toContain(
          AGENT_DEVICE_ACCESS_OFF,
        );
      }
      expect(activity).toEqual(before);
      // Closing stays available so a revoked agent can still release its device.
      expect((yield* call(threads.granted, "goat_device_close", {})).isError).toBe(false);
      expect((yield* (yield* DeviceService.DeviceService).state).sessions).toEqual([]);

      yield* settings.updateSettings({
        enableAgentDeviceAccess: false,
        projectSettingsOverrides: { [granted]: { enableAgentDeviceAccess: true } },
      });
      const reopened = yield* call(threads.granted, "goat_device_open", { deviceId: "SIM-1" });
      expect(reopened.isError, JSON.stringify(reopened.content)).toBe(false);
    }).pipe(
      Effect.provide(layer({ enableDeviceSupport: true, enableAgentDeviceAccess: true }, activity)),
    );
  });

  it.effect("device support off refuses a thread whose project grants access", () => {
    const activity: Array<string> = [];
    return Effect.gen(function* () {
      expect(
        refusal(yield* call(threads.granted, "goat_device_open", { platform: "ios" })),
      ).toContain("Device support is off");
      expect(activity).toEqual([]);
    }).pipe(
      Effect.provide(
        layer(
          {
            enableDeviceSupport: false,
            projectSettingsOverrides: { [granted]: { enableAgentDeviceAccess: true } },
          },
          activity,
        ),
      ),
    );
  });
});
