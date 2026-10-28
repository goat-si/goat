import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Runtime from "../../../auth/ConnectHubRuntime.testkit.ts";
import * as Settings from "../../../serverSettings.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Executor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

it.effect(
  "MCP unrelated preference commits preserve omitted hub consent and authorization generation",
  () =>
    Effect.gen(function* () {
      const watch = yield* Runtime.watcher;
      const runtime = yield* Runtime.open({ fs: watch.fs });
      yield* runtime.settings.start;
      yield* runtime.settings.updateSettings({
        hub: { enabled: true, connectDevicesHubProxy: true },
      });
      const before = yield* runtime.access.current;
      const threadId = ThreadId.make("connect-settings");
      const environmentId = EnvironmentId.make("connect-hub");
      const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const holder = yield* runtime.settings
        .withSettingsSnapshot(() =>
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      const dependencies = Layer.mergeAll(
        Executor.layer,
        Layer.succeed(Settings.ServerSettingsService, {
          ...runtime.settings,
          updateSettings: (...args) =>
            Deferred.succeed(queued, undefined).pipe(
              Effect.andThen(runtime.settings.updateSettings(...args)),
            ),
        }),
        Layer.succeed(Invocation.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:connect-settings",
          thread: {
            threadId,
            providerSessionId: "provider:connect-settings",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(Threads.ThreadManagementService)({ getThreadShell: () => Ref.get(caller) }),
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Hub",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "test",
            capabilities: { repositoryIdentity: false },
          }),
        }),
      );
      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const update = yield* toolkit
          .handle("goat_environment_preferences_update", { newWorktreesStartFromOrigin: true })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.forkScoped);
        yield* Deferred.await(queued);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const result = (yield* Fiber.join(update)).at(-1)?.result;
        expect(result).toMatchObject({
          hub: { enabled: true, connectDevicesHubProxy: true },
          newWorktreesStartFromOrigin: true,
        });
        expect((yield* runtime.settings.getSettings).hub).toMatchObject({
          enabled: true,
          connectDevicesHubProxy: true,
        });
        expect(yield* runtime.access.current).toEqual(before);
      }).pipe(
        Effect.provide(
          Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(dependencies)),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);
