import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Auth from "../../../auth/EnvironmentAuth.ts";
import * as Secrets from "../../../auth/ServerSecretStore.ts";
import * as Config from "../../../config.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import { disposableSwitch, withPersonConsent } from "../../../hub/disposable/disposableSwitch.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const layer = Layer.mergeAll(Auth.layer, Settings.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(Secrets.layer),
  Layer.provideMerge(Environment.layerIdentity),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "goat-disposable-prefs-mcp-" })),
  Layer.provideMerge(NodeServices.layer),
);

// An agent may turn the hub off and on; that is not the person's consent to attach machines.
it.effect("a thread turning the hub off and on cannot reopen an expired disposable switch", () =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const identity = yield* Environment.ServerEnvironmentIdentity;
    const environmentId = yield* identity.getEnvironmentId;
    const threadId = ThreadId.make("provisioner");
    yield* settings.start;
    yield* withPersonConsent(
      settings.updateSettings({
        hub: { enabled: true, attachDisposableMachines: { enabled: true } },
      }),
    );
    const opened = (yield* settings.getSettings).hub.attachDisposableMachines.expiresAt;
    yield* TestClock.adjust(31 * DAY_MS);
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
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
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
      for (const enabled of [false, true]) {
        const result = yield* toolkit
          .handle("goat_environment_preferences_update", { hub: { enabled } })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(result.at(-1)?.result).toMatchObject({ hub: { enabled } });
      }
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(dependencies)),
      ),
    );
    const hub = (yield* settings.getSettings).hub;
    expect(disposableSwitch(hub, 31 * DAY_MS).open).toBe(false);
    // Turning the hub off turned the switch off and cleared its expiry; nothing renewed it.
    expect(hub.attachDisposableMachines).toMatchObject({ enabled: false, expiresAt: null });
    expect(opened).not.toBeNull();
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
