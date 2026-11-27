import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import {
  bundledMockAgentPath,
  makeMockRuntime,
  rawProtocolMethod,
  rawProtocolRequest,
} from "./AcpMockRuntime.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
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
import {
  AcpProviderCapabilitiesV2,
  acpScopedNativeId,
  makeAcpAdapterV2,
} from "@goat/provider-acp/server/adapter";
import { normalizeXAiAcpToolCallState } from "@goat/provider-grok/testing";
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
                    .pipe(Effect.orDie, Effect.andThen(Deferred.await(adoptionHandled)));
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
                        Effect.orDie,
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
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("session/load replay does not leave post-settle background work pending", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      const instanceId = ProviderInstanceId.make("acp-test");
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          normalizeToolCall: normalizeXAiAcpToolCallState,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            }),
          }),
        },
        continuationRequests: { offer: () => Effect.void },
      });
      const threadId = ThreadId.make("thread-acp-load-replay-background");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-load-replay-background"),
        modelSelection,
        runtimePolicy,
      });
      if (runtime.hasPendingBackgroundWork === undefined) {
        return yield* Effect.die("ACP runtime must expose hasPendingBackgroundWork.");
      }
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      assert.isFalse(yield* runtime.hasPendingBackgroundWork);
      assert.isDefined(sessionUpdateHandler, "session update handler must be wired");

      // A large session/load replays its tail after the session is active.
      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        _meta: { isReplay: true },
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "old reply from history" },
        },
      });
      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        _meta: { isReplay: true },
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "replayed-tool-1",
          title: "run_command",
          kind: "execute",
          status: "completed",
          rawInput: { command: "echo old" },
        },
      });

      assert.isFalse(
        yield* runtime.hasPendingBackgroundWork,
        "replayed history must not pin background work",
      );
      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.deepEqual(
        snapshot.messages.map((message) => message.text),
        ["old reply from history"],
      );
    }).pipe(Effect.provide(layerTest)),
  );
  it.live(
    "delivers MCP appContext once per session, skips slash commands, and resends after unsuccessful turns, compaction, or runtime restart",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* bundledMockAgentPath;
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        let runtimeCount = 0;
        let cancelCalled: Deferred.Deferred<void> | undefined;
        const prompts: Array<string> = [];
        const queuedResponses: Array<
          | { readonly _tag: "immediate"; readonly response: EffectAcpSchema.PromptResponse }
          | {
              readonly _tag: "gated";
              readonly started: Deferred.Deferred<void>;
              readonly gate: Deferred.Deferred<EffectAcpSchema.PromptResponse>;
            }
        > = [];
        const instanceId = ProviderInstanceId.make("acp-test-app-context-lifecycle");
        const threadId = ThreadId.make("thread-acp-app-context-lifecycle");
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            restartRuntimeAfterInterrupt: true,
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              wrapRuntime: (runtime) => {
                runtimeCount += 1;
                return {
                  ...runtime,
                  handleSessionUpdate: (handler) =>
                    Effect.sync(() => {
                      sessionUpdateHandler = handler;
                    }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                  cancel: Effect.suspend(() =>
                    cancelCalled === undefined
                      ? Effect.void
                      : Deferred.succeed(cancelCalled, undefined).pipe(Effect.asVoid),
                  ),
                  prompt: (payload, promptOptions) =>
                    Effect.gen(function* () {
                      prompts.push(
                        payload.prompt
                          .flatMap((block) => (block.type === "text" ? [block.text] : []))
                          .join("\n"),
                      );
                      if (promptOptions?.dispatched) {
                        yield* Deferred.succeed(promptOptions.dispatched, undefined);
                      }
                      const next = queuedResponses.shift();
                      if (next === undefined) {
                        return { stopReason: "end_turn" as const };
                      }
                      if (next._tag === "immediate") {
                        return next.response;
                      }
                      yield* Deferred.succeed(next.started, undefined);
                      return yield* Deferred.await(next.gate);
                    }),
                };
              },
            }),
          },
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-app-context-lifecycle"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const sessionId = providerThread.nativeThreadRef?.nativeId;
        if (sessionId == null) return assert.fail("expected native session id");
        let ordinal = 0;
        const noteSetAt = "2026-11-23T14:02:17.000Z";
        const runTurn = (input: {
          readonly text: string;
          readonly note: string;
          readonly response?: EffectAcpSchema.PromptResponse;
        }) =>
          Effect.gen(function* () {
            ordinal += 1;
            if (input.response !== undefined) {
              queuedResponses.push({ _tag: "immediate", response: input.response });
            }
            yield* runtime.startTurn({
              ...makeTurnInput({
                threadId,
                providerThread,
                instanceId,
                runtimePolicy,
                now: yield* DateTime.now,
                ordinal,
                messageText: input.text,
              }),
              appContext: [{ key: "mcp_app_item-1", text: input.note, updatedAt: noteSetAt }],
            });
            const events = Array.from(
              yield* runtime.events.pipe(
                Stream.takeUntil((event) => event.type === "turn.terminal"),
                Stream.runCollect,
              ),
            );
            const terminal = events.at(-1);
            return {
              prompt: prompts.at(-1) ?? "",
              status: terminal?.type === "turn.terminal" ? terminal.status : null,
            };
          });

        // Every send, a resend included, says when the app set the note.
        const tag = (note: string) =>
          `<external_mcp_app_item-1 updated_at="${noteSetAt}">${note}</external_mcp_app_item-1>`;

        // An unsuccessful stop reason must not mark appContext delivered.
        const refusedTurn = yield* runTurn({
          text: "Refused attempt",
          note: "Created Jira issue PROJ-42",
          response: { stopReason: "refusal" },
        });
        assert.include(refusedTurn.prompt, tag("Created Jira issue PROJ-42"));

        // Interrupted turns must not mark appContext delivered even if the prompt answers end_turn.
        const interruptedStarted = yield* Deferred.make<void>();
        const interruptedGate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
        cancelCalled = yield* Deferred.make<void>();
        queuedResponses.push({
          _tag: "gated",
          started: interruptedStarted,
          gate: interruptedGate,
        });
        ordinal += 1;
        const interruptedOrdinal = ordinal;
        yield* runtime.startTurn({
          ...makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
            ordinal: interruptedOrdinal,
            messageText: "Interrupted attempt",
          }),
          appContext: [
            { key: "mcp_app_item-1", text: "Created Jira issue PROJ-42", updatedAt: noteSetAt },
          ],
        });
        yield* Deferred.await(interruptedStarted);
        assert.include(prompts.at(-1) ?? "", tag("Created Jira issue PROJ-42"));
        const interruptFiber = yield* runtime
          .interruptTurn({
            providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: ACP_TEST_DRIVER,
              nativeTurnId: acpScopedNativeId(
                instanceId,
                `${sessionId}:turn:${interruptedOrdinal}`,
              ),
            }),
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(cancelCalled);
        yield* Deferred.succeed(interruptedGate, { stopReason: "end_turn" });
        yield* Fiber.join(interruptFiber);
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );

        // Native slash commands skip appContext injection; the next normal turn sends it.
        const slashTurn = yield* runTurn({
          text: "  /repro-skill",
          note: "Created Jira issue PROJ-42",
        });
        assert.equal(slashTurn.status, "completed");
        assert.notInclude(slashTurn.prompt, "external_mcp_app_item-1");

        const deliveredTurn = yield* runTurn({
          text: "What did the app report?",
          note: "Created Jira issue PROJ-42",
        });
        assert.equal(deliveredTurn.status, "completed");
        assert.include(deliveredTurn.prompt, tag("Created Jira issue PROJ-42"));

        // Unchanged note is not resent; changed note is sent once.
        const unchangedTurn = yield* runTurn({
          text: "Follow up",
          note: "Created Jira issue PROJ-42",
        });
        assert.notInclude(unchangedTurn.prompt, "external_mcp_app_item-1");

        const changedTurn = yield* runTurn({
          text: "Updated check",
          note: "Updated Jira issue PROJ-43",
        });
        assert.include(changedTurn.prompt, tag("Updated Jira issue PROJ-43"));

        const afterChangeTurn = yield* runTurn({
          text: "Second follow up",
          note: "Updated Jira issue PROJ-43",
        });
        assert.notInclude(afterChangeTurn.prompt, "external_mcp_app_item-1");

        // Compaction clears delivered appContext so the next turn resends it.
        yield* sessionUpdateHandler!({
          sessionId,
          update: {
            sessionUpdate: "compaction_update",
            compactionId: "compact-app-context",
            status: "completed",
          },
        });
        const postCompactTurn = yield* runTurn({
          text: "After compaction",
          note: "Updated Jira issue PROJ-43",
        });
        assert.include(postCompactTurn.prompt, tag("Updated Jira issue PROJ-43"));

        const afterPostCompactTurn = yield* runTurn({
          text: "Already resent after compaction",
          note: "Updated Jira issue PROJ-43",
        });
        assert.notInclude(afterPostCompactTurn.prompt, "external_mcp_app_item-1");

        // Runtime restart clears delivered appContext even when resuming the same session id.
        const restartStarted = yield* Deferred.make<void>();
        const restartGate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
        cancelCalled = yield* Deferred.make<void>();
        queuedResponses.push({
          _tag: "gated",
          started: restartStarted,
          gate: restartGate,
        });
        ordinal += 1;
        const restartOrdinal = ordinal;
        yield* runtime.startTurn({
          ...makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
            ordinal: restartOrdinal,
            messageText: "Trigger restart",
          }),
          appContext: [
            { key: "mcp_app_item-1", text: "Updated Jira issue PROJ-43", updatedAt: noteSetAt },
          ],
        });
        yield* Deferred.await(restartStarted);
        const restartInterruptFiber = yield* runtime
          .interruptTurn({
            providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: ACP_TEST_DRIVER,
              nativeTurnId: acpScopedNativeId(instanceId, `${sessionId}:turn:${restartOrdinal}`),
            }),
            requestRuntimeRestart: true,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(cancelCalled);
        yield* Deferred.succeed(restartGate, { stopReason: "cancelled" });
        yield* Fiber.join(restartInterruptFiber);
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );

        const postRestartTurn = yield* runTurn({
          text: "After runtime restart",
          note: "Updated Jira issue PROJ-43",
        });
        assert.isAbove(runtimeCount, 1);
        assert.include(postRestartTurn.prompt, tag("Updated Jira issue PROJ-43"));
      }).pipe(Effect.provide(layerTest)),
  );
});
