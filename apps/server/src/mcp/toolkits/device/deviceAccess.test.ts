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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
  physical: false,
};

interface Fixture {
  readonly activity: Array<string>;
  /** Present when the simulator starts shut down; booting runs this first. */
  readonly boot?: Effect.Effect<void>;
  /** Runs before agent-device configuration is written for a device. */
  readonly configure?: Effect.Effect<void>;
  readonly projectLookupFails?: boolean;
}

// A local iOS host that records agent tool starts, device attaches, and agent-device configuration.
const makeDeviceService = ({ activity, boot, configure }: Fixture) =>
  Effect.gen(function* () {
    let booted = boot === undefined;
    const ready: DeviceHost.DeviceHostReady = {
      nodePath: process.execPath,
      hub: { origin: "http://device.test" },
      devices: {
        list: Effect.sync(() => ({ devices: [{ ...simulator, booted }], detail: undefined })),
        boot: () =>
          (boot ?? Effect.void).pipe(
            Effect.map(() => {
              booted = true;
              return simulator.id;
            }),
          ),
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
      (configure ?? Effect.void).pipe(
        Effect.map(() => {
          activity.push("configure");
          return "/host.json";
        }),
      ),
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

const project = (id: ProjectId) =>
  ({
    id,
    title: id,
    workspaceRoot: process.cwd(),
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  }) as Project;

const projectsLayer = (lookupFails: boolean) =>
  Layer.mock(ProjectService.ProjectService)({
    getById: (projectId) =>
      lookupFails
        ? Effect.fail(
            new ProjectService.ProjectOperationError({
              operation: "read-project",
              projectId,
              cause: new Error("database is locked"),
            }),
          )
        : Effect.succeed(projectId === deleted ? Option.none() : Option.some(project(projectId))),
  });

const layer = (settings: Parameters<typeof ServerSettings.layerTest>[0], fixture: Fixture) =>
  McpHttpServer.layerDeviceToolkit.pipe(
    Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(threadsLayer),
    Layer.provideMerge(Layer.effect(DeviceService.DeviceService, makeDeviceService(fixture))),
    Layer.provideMerge(ServerSettings.layerTest(settings)),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(projectsLayer(fixture.projectLookupFails === true)),
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
  readonly isError?: boolean | undefined;
  readonly content: ReadonlyArray<unknown>;
}) => (result.isError === true ? JSON.stringify(result.content) : "not refused");

const envOffProjectOn = {
  enableDeviceSupport: true,
  enableAgentDeviceAccess: false,
  projectSettingsOverrides: { [granted]: { enableAgentDeviceAccess: true } },
};

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
        expect(activity).toContain("configure");
        const afterGrant = [...activity];

        for (const threadId of [threads.other, threads.orphaned]) {
          expect(refusal(yield* call(threadId, "goat_device_open", { platform: "ios" }))).toContain(
            AGENT_DEVICE_ACCESS_OFF,
          );
        }
        expect(
          refusal(yield* call(threads.missing, "goat_device_open", { platform: "ios" })),
        ).toContain("thread_not_found");
        expect(activity).toEqual(afterGrant);
      }).pipe(Effect.provide(layer(envOffProjectOn, { activity })));
    },
  );

  it.effect("access changed after the credential was issued applies to the next call", () => {
    const activity: Array<string> = [];
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const keyedOpen = { deviceId: "SIM-1", clientRequestId: "open-1" };
      const opened = yield* call(threads.granted, "goat_device_open", keyedOpen);
      expect(opened.isError, JSON.stringify(opened.content)).toBe(false);

      yield* settings.updateSettings({
        projectSettingsOverrides: { [granted]: { enableAgentDeviceAccess: false } },
      });
      const before = [...activity];
      // The device is open in this thread, so only the access check can refuse the screenshot.
      const screenshot = yield* call(threads.granted, "goat_device_screenshot", {
        deviceId: "SIM-1",
      });
      expect(screenshot.isError).toBe(true);
      expect(screenshot.structuredContent).toMatchObject({
        error: { _tag: "DeviceToolUnavailableError" },
      });
      for (const [name, args] of [
        ["goat_device_list", {}],
        // A retry with the same key must not replay the earlier grant.
        ["goat_device_open", keyedOpen],
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

      yield* settings.updateSettings(envOffProjectOn);
      const reopened = yield* call(threads.granted, "goat_device_open", { deviceId: "SIM-1" });
      expect(reopened.isError, JSON.stringify(reopened.content)).toBe(false);
    }).pipe(
      Effect.provide(
        layer({ enableDeviceSupport: true, enableAgentDeviceAccess: true }, { activity }),
      ),
    );
  });

  it.effect("access revoked while a device boots withholds its agent-device configuration", () => {
    const activity: Array<string> = [];
    return Effect.gen(function* () {
      const bootStarted = yield* Deferred.make<void>();
      const finishBoot = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        const opening = yield* call(threads.granted, "goat_device_open", {
          deviceId: "SIM-1",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(bootStarted);
        yield* settings.updateSettings({
          projectSettingsOverrides: { [granted]: { enableAgentDeviceAccess: false } },
        });
        yield* Deferred.succeed(finishBoot, undefined);
        expect(refusal(yield* Fiber.join(opening))).toContain(AGENT_DEVICE_ACCESS_OFF);
        expect(activity).not.toContain("configure");
      }).pipe(
        Effect.provide(
          layer(envOffProjectOn, {
            activity,
            boot: Deferred.succeed(bootStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishBoot)),
            ),
          }),
        ),
      );
    });
  });

  it.effect("access revoked while agent-device is configured withholds its flags", () => {
    const activity: Array<string> = [];
    return Effect.gen(function* () {
      const configureStarted = yield* Deferred.make<void>();
      const finishConfigure = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        const opening = yield* call(threads.granted, "goat_device_open", {
          deviceId: "SIM-1",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(configureStarted);
        yield* settings.updateSettings({
          projectSettingsOverrides: { [granted]: { enableAgentDeviceAccess: false } },
        });
        yield* Deferred.succeed(finishConfigure, undefined);
        const result = yield* Fiber.join(opening);
        expect(refusal(result)).toContain(AGENT_DEVICE_ACCESS_OFF);
        expect(JSON.stringify(result)).not.toContain("/host.json");
      }).pipe(
        Effect.provide(
          layer(envOffProjectOn, {
            activity,
            configure: Deferred.succeed(configureStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishConfigure)),
            ),
          }),
        ),
      );
    });
  });

  it.effect("a project lookup that fails refuses instead of falling back to a default", () => {
    const activity: Array<string> = [];
    return Effect.gen(function* () {
      expect(
        refusal(yield* call(threads.granted, "goat_device_open", { platform: "ios" })),
      ).toContain(AGENT_DEVICE_ACCESS_OFF);
      expect(activity).toEqual([]);
    }).pipe(
      Effect.provide(
        layer(
          { enableDeviceSupport: true, enableAgentDeviceAccess: true },
          { activity, projectLookupFails: true },
        ),
      ),
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
      Effect.provide(layer({ ...envOffProjectOn, enableDeviceSupport: false }, { activity })),
    );
  });
});
