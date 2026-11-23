import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import {
  makeMockRuntime,
  rawProtocolMethod,
  rawProtocolRequest,
} from "./AcpMockRuntime.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import { layerTest, ACP_TEST_DRIVER } from "./AcpAdapterV2.host.testkit.ts";

const makeLateMockRuntime = (options: Parameters<typeof makeMockRuntime>[0]) => {
  const makeRuntime = makeMockRuntime(options);
  return ((input) => {
    const adjusted = {
      ...input,
      sessionLoadReplayIdleGap: "100 millis" as const,
      sessionLoadReplayIdleReadiness: true,
    };
    return makeRuntime(adjusted);
  }) satisfies ReturnType<typeof makeMockRuntime>;
};

describe("late ACP session load", () => {
  it.live("enables model switching when session/load answers with a model after replay idle", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const lateConfigOptions = yield* Deferred.make<void>();
      let acpRuntime: AcpSessionRuntime.AcpSessionRuntime["Service"] | undefined;
      const publishedConfigurations: Array<ReadonlyArray<EffectAcpSchema.SessionConfigOption>> = [];
      const instanceId = ProviderInstanceId.make("acp-test-late-session-load");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          onSessionConfigurationUpdate: (configOptions) =>
            Effect.sync(() => publishedConfigurations.push(configOptions)),
          makeRuntime: makeLateMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: {
              GOAT_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY: "1",
              GOAT_ACP_HOLD_LOAD_AFTER_REPLAY: "1",
            },
            wrapRuntime: (runtime) => {
              acpRuntime = runtime;
              return {
                ...runtime,
                getEvents: () =>
                  runtime
                    .getEvents()
                    .pipe(
                      Stream.tap((event) =>
                        event._tag === "ConfigOptionsUpdated"
                          ? Deferred.succeed(lateConfigOptions, undefined)
                          : Effect.void,
                      ),
                    ),
              };
            },
          }),
        },
        selfInvocation,
      });
      const runtime = yield* adapter.openSession({
        threadId: ThreadId.make("thread-acp-late-session-load"),
        providerSessionId: ProviderSessionId.make("provider-session-acp-late-session-load"),
        modelSelection: { instanceId, model: "default" },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        }),
        initialNativeThreadId: "mock-session-1",
      });

      if (acpRuntime === undefined) return yield* Effect.die("ACP runtime was not created");
      yield* acpRuntime.request("_test/release-load", {});
      yield* Deferred.await(lateConfigOptions);
      yield* acpRuntime.drainEvents;

      assert.isTrue(
        runtime.providerSession.capabilities.sessions.supportsModelSwitchInSession,
        "model switching stays disabled after the late session/load response offered a model",
      );
      // Registry agents fill their model picker from this callback.
      assert.equal(
        publishedConfigurations.filter((options) =>
          options.some((option) => option.category === "model"),
        ).length,
        1,
        "the late session/load configuration must reach the catalog exactly once",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("applies the thread's model after a late session/load that lands during open", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const adoptionHandled = yield* Deferred.make<void>();
      const adopted = yield* Deferred.make<void>();
      const publishedConfigurations: Array<ReadonlyArray<EffectAcpSchema.SessionConfigOption>> = [];
      let publications = 0;
      let acpRuntime: AcpSessionRuntime.AcpSessionRuntime["Service"] | undefined;
      const instanceId = ProviderInstanceId.make("acp-test-late-session-load-selection");
      const threadId = ThreadId.make("thread-acp-late-session-load-selection");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          onSessionEvent: (event) =>
            event._tag === "SessionSetupAdopted"
              ? Deferred.succeed(adoptionHandled, undefined).pipe(Effect.asVoid)
              : Effect.void,
          // Holds openSession's own publication until the adapter has seen the
          // late response, so adoption overlaps session configuration.
          onSessionConfigurationUpdate: (configOptions) =>
            (publications++ === 0
              ? Effect.suspend(() => {
                  if (acpRuntime === undefined) return Effect.die("ACP runtime was not created");
                  return acpRuntime
                    .request("_test/release-load", {})
                    .pipe(Effect.andThen(Deferred.await(adoptionHandled)));
                })
              : Effect.void
            ).pipe(
              Effect.andThen(Effect.sync(() => publishedConfigurations.push(configOptions))),
              Effect.andThen(
                configOptions.some((option) => option.category === "model")
                  ? Deferred.succeed(adopted, undefined)
                  : Effect.void,
              ),
            ),
          makeRuntime: makeLateMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
            environment: {
              GOAT_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY: "1",
              GOAT_ACP_HOLD_LOAD_AFTER_REPLAY: "1",
            },
            wrapRuntime: (runtime) => {
              acpRuntime = runtime;
              return runtime;
            },
          }),
        },
        selfInvocation,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "composer-2" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-late-load-selection"),
        modelSelection,
        runtimePolicy,
        initialNativeThreadId: "mock-session-1",
      });
      yield* Deferred.await(adopted);
      if (acpRuntime === undefined) return yield* Effect.die("ACP runtime was not created");
      yield* acpRuntime.drainEvents;
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* Queue.clear(protocolEvents);

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          modelSelection,
          now: yield* DateTime.now,
        }),
      );
      const methods: Array<string> = [];
      while (!methods.includes("session/prompt")) {
        const event = yield* Queue.take(protocolEvents);
        if (event.direction !== "outgoing") continue;
        const method = rawProtocolMethod(event);
        if (method !== undefined) methods.push(method);
      }

      assert.include(
        methods,
        "session/set_config_option",
        "the selected model was only applied to the provisional setup, which offered no model",
      );
      assert.isTrue(
        publishedConfigurations.at(-1)?.some((option) => option.category === "model"),
        "the provisional catalog was published over the late session/load one",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // Adoption either reaches the adapter after openSession configured the
  // provisional setup, or before it, so openSession configures the adopted one.
  it.live.each([false, true])(
    "restores the native build mode after a Plan turn that followed a late session/load (adopted before configuration: %s)",
    (adoptedBeforeConfiguration) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
        const adopted = yield* Deferred.make<void>();
        const adoptionHandled = yield* Deferred.make<void>();
        let holdFirstModeRead = adoptedBeforeConfiguration;
        let acpRuntime: AcpSessionRuntime.AcpSessionRuntime["Service"] | undefined;
        const instanceId = ProviderInstanceId.make("acp-test-late-session-load-plan");
        const threadId = ThreadId.make("thread-acp-late-session-load-plan");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            onSessionEvent: (event) =>
              event._tag === "SessionSetupAdopted"
                ? Deferred.succeed(adoptionHandled, undefined).pipe(Effect.asVoid)
                : Effect.void,
            makeRuntime: makeLateMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              protocolEvents,
              environment: {
                GOAT_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY: "1",
                GOAT_ACP_HOLD_LOAD_AFTER_REPLAY: "1",
              },
              wrapRuntime: (runtime) => {
                acpRuntime = runtime;
                return {
                  ...runtime,
                  getModeState: Effect.suspend(() => {
                    if (!holdFirstModeRead) return runtime.getModeState;
                    holdFirstModeRead = false;
                    return runtime
                      .request("_test/release-load", {})
                      .pipe(
                        Effect.andThen(Deferred.await(adoptionHandled)),
                        Effect.andThen(runtime.getModeState),
                      );
                  }),
                  getEvents: () =>
                    runtime
                      .getEvents()
                      .pipe(
                        Stream.tap((event) =>
                          event._tag === "SessionSetupAdopted"
                            ? Deferred.succeed(adopted, undefined)
                            : Effect.void,
                        ),
                      ),
                };
              },
            }),
          },
          selfInvocation,
        });
        const policy = (interactionMode: "default" | "plan") =>
          ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode,
            cwd: process.cwd(),
          });
        const planPolicy = policy("plan");
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-late-load-plan"),
          modelSelection,
          runtimePolicy: planPolicy,
          initialNativeThreadId: "mock-session-1",
        });
        if (acpRuntime === undefined) return yield* Effect.die("ACP runtime was not created");
        if (!adoptedBeforeConfiguration) yield* acpRuntime.request("_test/release-load", {});
        yield* Deferred.await(adopted);
        yield* acpRuntime.drainEvents;
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: planPolicy,
        });
        yield* Queue.clear(protocolEvents);
        const now = yield* DateTime.now;
        const runTurn = Effect.fnUntraced(function* (
          ordinal: number,
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
        ) {
          yield* runtime.startTurn(
            makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal }),
          );
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runDrain,
          );
          const modeValues: Array<unknown> = [];
          while (true) {
            const event = yield* Queue.take(protocolEvents);
            if (event.direction !== "outgoing") continue;
            const request = rawProtocolRequest(event);
            if (request?.method === "session/prompt") return modeValues;
            if (request?.method === "session/set_config_option") {
              modeValues.push((request.params as { readonly value?: unknown }).value);
            }
          }
        });

        // Configured against the adopted setup, openSession already switched to Plan.
        assert.deepEqual(
          yield* runTurn(0, planPolicy),
          adoptedBeforeConfiguration ? [] : ["architect"],
        );
        assert.deepEqual(
          yield* runTurn(1, policy("default")),
          ["ask"],
          "Build must restore the mode the late session/load reported, not the provisional setup's",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("persists context usage the agent reports after its prompt settles", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const promptStarted = yield* Deferred.make<void>();
      const promptGate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              prompt: () =>
                Deferred.succeed(promptStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(promptGate)),
                ),
            }),
          }),
        },
      });
      const threadId = ThreadId.make("thread-acp-late-usage");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-late-usage"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(promptStarted);
      const update = (update: EffectAcpSchema.SessionUpdate) =>
        sessionUpdateHandler!({ sessionId: "mock-session-1", update });
      yield* update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "OK" },
      });
      yield* Deferred.succeed(promptGate, { stopReason: "end_turn" });
      while ((yield* Queue.take(events)).type !== "turn.terminal");

      // Kimi Code 2.6.2 sends its usage_update just after answering session/prompt.
      yield* update({ sessionUpdate: "usage_update", used: 13101, size: 1048576 });
      let late: ProviderAdapter.ProviderAdapterV2Event;
      do late = yield* Queue.take(events);
      while (late.type !== "provider_thread.updated");
      assert.deepInclude(late.providerThread.contextUsage, { usedTokens: 13101 });
      // With no run left to receive it, only a session-scoped update reaches the projection.
      assert.isTrue(late.sessionScoped);
      assert.equal(late.providerThread.status, "idle");
      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.deepEqual(snapshot.providerTurns, []);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
