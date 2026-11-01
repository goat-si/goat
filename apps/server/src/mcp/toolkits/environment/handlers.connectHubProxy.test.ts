import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Auth from "../../../auth/EnvironmentAuth.ts";
import * as Access from "../../../auth/HubConnectAccess.ts";
import * as Secrets from "../../../auth/ServerSecretStore.ts";
import * as Config from "../../../config.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as Settings from "../../../serverSettings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const layer = Layer.mergeAll(Auth.layer, Settings.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(Secrets.layer),
  Layer.provideMerge(Environment.layerIdentity),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "goat-connect-settings-mcp-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect.each(["ended turn", "loss of full access"] as const)(
  "MCP settings commit rechecks an admitted caller after %s behind the settings permit",
  (loss) =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const auth = yield* Auth.EnvironmentAuth;
      const access = yield* Access.HubConnectAccess;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const identity = yield* Environment.ServerEnvironmentIdentity;
      const environmentId = yield* identity.getEnvironmentId;
      const threadId = ThreadId.make("settings-caller");
      const caller = yield* Ref.make(liveThreadShell(threadId));
      yield* settings.start;
      yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
      const before = yield* fs.readFileString(config.settingsPath);
      const generation = (yield* access.current).generation;
      const dependencies = Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:settings",
          client: undefined,
          thread: {
            threadId,
            providerSessionId: "provider:settings",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Ref.get(caller),
        }),
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Test hub",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "test",
            capabilities: { repositoryIdentity: false },
          }),
        }),
      );
      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const queued = yield* Deferred.make<void>();
        const holder = yield* settings
          .withSettingsSnapshot(() =>
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(held);
        const original = settings.updateSettings;
        using _update = vi
          .spyOn(settings, "updateSettings")
          .mockImplementation((...args) =>
            Deferred.succeed(queued, undefined).pipe(Effect.andThen(original(...args))),
          );
        const update = yield* toolkit
          .handle("goat_environment_preferences_update", {
            hub: { connectDevicesHubProxy: false },
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.forkScoped);
        yield* Deferred.await(queued);
        yield* Ref.update(caller, (shell) =>
          loss === "ended turn"
            ? { ...shell, activeRunId: null }
            : { ...shell, runtimeMode: "approval-required" as const },
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const result = yield* Fiber.join(update);
        expect(result.at(-1)?.result).toHaveProperty("code");
        expect(yield* fs.readFileString(config.settingsPath)).toBe(before);
        expect(yield* access.current).toMatchObject({ generation, allowed: true });
        expect(
          (yield* auth.createCloudConnectPairingLink({ proofKeyThumbprint: "device-key" })).scopes,
        ).toContain("hub:proxy");
        yield* Ref.set(caller, liveThreadShell(threadId));
        const preferences = yield* toolkit
          .handle("goat_environment_preferences_update", { newWorktreesStartFromOrigin: false })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(preferences.at(-1)?.result).toMatchObject({
          hub: { enabled: true, connectDevicesHubProxy: true },
        });
        const off = yield* toolkit
          .handle("goat_environment_preferences_update", { hub: { enabled: false } })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(off.at(-1)?.result).toMatchObject({
          hub: { enabled: false, connectDevicesHubProxy: true },
        });
        expect((yield* access.current).generation).toBeGreaterThan(generation);
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(dependencies)),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
