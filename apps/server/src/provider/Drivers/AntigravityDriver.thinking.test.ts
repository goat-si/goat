import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderSessionId, ThreadId, type ServerProvider } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { makeTurnInput } from "../../orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import { makeHarness, windowsHost } from "./AntigravityDriver.testkit.ts";

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-antigravity-driver-thinking-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected quota request")),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
);

const layerTest = ProviderHostLive.layer.pipe(
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("memory-host-fixture")),
    }),
  ),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(layerDeps),
);

it.layer(layerTest)("AntigravityDriver thinking defaults", (it) => {
  it.effect.skipIf(windowsHost)(
    "keeps catalog default thinking levels when a chat session selects another level",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          environment: [
            { name: "GOAT_ACP_ANTIGRAVITY_THOUGHT_LEVEL", value: "1" },
            { name: "GOAT_ACP_RESUME_THOUGHT_LEVEL", value: "xhigh" },
          ],
        });
        yield* h.refresh();
        const levelOf = (snapshot: ServerProvider, slug: string) => {
          const option = snapshot.models
            .find((model) => model.slug === slug)
            ?.capabilities?.optionDescriptors?.find(
              (descriptor) => descriptor.id === "thought_level",
            );
          return option?.type === "select" ? option.currentValue : undefined;
        };

        const refreshed = yield* h.instance.snapshot.getSnapshot;
        expect(levelOf(refreshed, "gemini-test-low")).toBe("high");
        expect(levelOf(refreshed, "gemini-test-high")).toBe("medium");

        const threadId = ThreadId.make("thread-antigravity-thought-level");
        const xhighSelection = {
          instanceId: h.instance.instanceId,
          model: "gemini-test-low",
          options: [{ id: "thought_level", value: "xhigh" }],
        };
        const nativeSessionId = yield* Effect.scoped(
          Effect.gen(function* () {
            const workspace = yield* h.fs.makeTempDirectoryScoped({ prefix: "goat-ag-thought-" });
            const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: workspace,
            });
            const session = yield* h.instance.orchestrationAdapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make(
                "provider-session-antigravity-thought-level",
              ),
              modelSelection: xhighSelection,
              runtimePolicy,
            });
            const providerThread = yield* session.ensureThread({
              threadId,
              modelSelection: xhighSelection,
              runtimePolicy,
            });
            yield* session.startTurn(
              makeTurnInput({
                threadId,
                providerThread,
                instanceId: h.instance.instanceId,
                modelSelection: xhighSelection,
                runtimePolicy,
                now: yield* DateTime.now,
                ordinal: 1,
                messageText: "Say ok.",
              }),
            );
            yield* session.events.pipe(
              Stream.takeUntil((event) => event.type === "turn.terminal"),
              Stream.runDrain,
            );
            const nativeId = providerThread.nativeThreadRef?.nativeId;
            if (!nativeId) {
              return yield* Effect.die("Expected Antigravity session to have a native thread id");
            }
            return nativeId;
          }),
        );

        const afterLiveSession = yield* h.instance.snapshot.getSnapshot;
        expect(levelOf(afterLiveSession, "gemini-test-low")).toBe("high");
        expect(levelOf(afterLiveSession, "gemini-test-high")).toBe("medium");
        expect(
          afterLiveSession.models.find((model) => model.slug === "gemini-test-low")?.isDefault,
        ).toBe(true);
        expect(
          (yield* h.readRequests)
            .filter(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "thought_level",
            )
            .map((request) => request.params?.value),
        ).toEqual(["xhigh"]);

        // Resuming a session whose saved level is xhigh must also keep the catalog default.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const workspace = yield* h.fs.makeTempDirectoryScoped({
              prefix: "goat-ag-thought-resume-",
            });
            const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: workspace,
            });
            const resumed = yield* h.instance.orchestrationAdapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make(
                "provider-session-antigravity-thought-level-resumed",
              ),
              modelSelection: xhighSelection,
              runtimePolicy,
              initialNativeThreadId: nativeSessionId,
            });
            yield* resumed.ensureThread({
              threadId,
              modelSelection: xhighSelection,
              runtimePolicy,
            });
          }),
        );
        expect(levelOf(yield* h.instance.snapshot.getSnapshot, "gemini-test-low")).toBe("high");
        yield* h.assertClosed;
      }),
  );
});
