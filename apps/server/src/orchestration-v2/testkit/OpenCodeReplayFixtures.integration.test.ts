import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId, type ProviderReplayEntry } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Continuations from "@goat/provider-core/server/ProviderContinuationRequests";
import * as OpenCodeRuntime from "@goat/provider-opencode/server/OpenCodeRuntime";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  layerOpenCodeTestAdapterRegistry,
  OpenCodeOrchestratorReplayHarness,
} from "../Adapters/OpenCodeAdapterV2.testkit.ts";
import {
  OPENCODE2_HTTP_PROTOCOL,
  OpenCode2OrchestratorReplayHarness,
} from "../Adapters/OpenCode2AdapterV2.testkit.ts";
import * as EventSink from "../EventSink.ts";
import { emptyState, runtimePolicy } from "../ProviderSessionFixture.testkit.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import { layerTest } from "../test/ProviderSessionManagerHarness.testkit.ts";
import { makeThreadCreatedEvent } from "../test/ProviderSessionManagerMemoryDto.testkit.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  readReplayFixtureTranscript,
  runReplayFixture,
  type ReplayFixtureCase,
} from "./ProviderReplayFixtures.ts";
import { openCodeBackgroundWakeInput } from "./fixtures/opencode_background_wake/input.ts";
import { assertOpenCodeBackgroundWakeOutput } from "./fixtures/opencode_background_wake/output.ts";
import { OPENCODE_MODEL_SELECTION } from "./fixtures/shared.ts";

// OpenCode fixtures are recorded against either the v1 or the v2 HTTP protocol.
function runOpenCodeReplayFixture(input: ReplayFixtureCase) {
  return readReplayFixtureTranscript(input.driver.transcriptFile).pipe(
    Effect.flatMap((transcript) =>
      transcript.protocol === OPENCODE2_HTTP_PROTOCOL
        ? runReplayFixture({ ...input, harness: OpenCode2OrchestratorReplayHarness })
        : runReplayFixture({ ...input, harness: OpenCodeOrchestratorReplayHarness }),
    ),
  );
}

describe("OpenCode replay fixtures", () => {
  itRunsReplayFixtures("opencode", runOpenCodeReplayFixture);

  it.effect("projects a late OpenCode 1.x reply in its own continuation run", () =>
    runOpenCodeReplayFixture({
      fixtureName: "opencode_background_wake",
      buildInput: openCodeBackgroundWakeInput,
      driver: {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./fixtures/opencode_background_wake/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertOpenCodeBackgroundWakeOutput,
      },
    }),
  );

  it.effect.each(["root-running", "root-settled", "held-wake", "held-wake-settled"] as const)(
    "separates the OpenCode 1.x root Stop deadline from child cleanup when %s",
    (scenario) =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const nativeEvents = yield* Queue.unbounded<unknown>();
        const root = { id: "root", time: { created: 1, updated: 1 } };
        const rootIdle = { type: "session.idle", properties: { sessionID: root.id } };
        const wakeIdle = { ...rootIdle };
        const wakeIdleConsumed = yield* Deferred.make<void>();
        const abortRoot = Promise.withResolvers<AbortSignal>();
        const abortChild = Promise.withResolvers<AbortSignal>();
        const unanswered = Promise.withResolvers<never>();
        const offeredWake = yield* Deferred.make<Continuations.ProviderContinuationRequest>();
        let prompts = 0;
        let promptId = "";
        const client = {
          mcp: { add: async () => ({ data: true }) },
          event: {
            subscribe: async () => ({
              stream: {
                async *[Symbol.asyncIterator]() {
                  for await (const event of Stream.toAsyncIterable(
                    Stream.fromQueue(nativeEvents),
                  )) {
                    yield event;
                    // The adapter pulls again only after handling the previous event.
                    if (event === wakeIdle) Deferred.doneUnsafe(wakeIdleConsumed, Effect.void);
                  }
                },
              },
            }),
          },
          session: {
            create: async () => ({ data: root }),
            get: async () => ({ data: root }),
            messages: async () => ({ data: [] }),
            promptAsync: async ({ messageID }: { messageID: string }) => {
              prompts++;
              promptId = messageID;
              return { data: true };
            },
            children: async ({ sessionID }: { sessionID: string }) => ({
              data: sessionID === root.id ? [{ id: "child" }] : [],
            }),
            abort: ({ sessionID }: { sessionID: string }, { signal }: { signal: AbortSignal }) => {
              (sessionID === root.id ? abortRoot : abortChild).resolve(signal);
              return unanswered.promise;
            },
          },
        };
        const adapterRegistryLayer = layerOpenCodeTestAdapterRegistry(
          Layer.mock(OpenCodeRuntime.OpenCodeRuntime)({
            connectToOpenCodeServer: () =>
              Effect.succeed({
                url: "http://opencode.invalid",
                version: "1.18.32",
                external: false,
                exitCode: null,
              }),
            createOpenCodeSdkClient: () => client as unknown as OpencodeClient,
          }),
        ).pipe(
          Layer.provide(
            Layer.succeed(Continuations.ProviderContinuationRequests, {
              offer: (request) => Deferred.succeed(offeredWake, request).pipe(Effect.asVoid),
              take: Effect.never,
            }),
          ),
          Layer.orDie,
        );
        yield* Effect.gen(function* () {
          const store = yield* EventSink.EventSinkV2;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const threadId = ThreadId.make("opencode-stop-deadline");
          const modelSelection = {
            instanceId: OPENCODE_MODEL_SELECTION.instanceId,
            model: OPENCODE_MODEL_SELECTION.model,
          };
          const thread = yield* makeThreadCreatedEvent({
            idAllocator,
            threadId,
            now: yield* DateTime.now,
          });
          const appThread = {
            ...thread.payload,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
          };
          yield* store.write({ events: [{ ...thread, payload: appThread }] });
          const providerSessionId = idAllocator.derive.providerSession({
            providerInstanceId: modelSelection.instanceId,
          });
          const runtime = yield* manager.open({
            threadId,
            modelSelection,
            runtimePolicy,
            providerSessionId,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const start = (ordinal: number) =>
            Effect.gen(function* () {
              const runId = idAllocator.derive.run({ threadId, ordinal });
              yield* runtime.startTurn({
                appThread,
                threadId,
                runId,
                runOrdinal: ordinal,
                providerTurnOrdinal: ordinal,
                rootNodeId: idAllocator.derive.rootNode({ runId }),
                attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
                providerThread,
                modelSelection,
                runtimePolicy,
                message: {
                  messageId: yield* idAllocator.allocate.message({ threadId, ordinal }),
                  text: "work",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                },
              });
            });
          yield* start(1);
          const { providerTurns } = yield* runtime.readThreadSnapshot({ providerThread });
          const turn = providerTurns.at(-1)!;
          const terminal = yield* runtime.events.pipe(
            Stream.filter((event) => event.type === "turn.terminal"),
            Stream.runHead,
            Effect.forkChild,
          );
          const settleRoot = Queue.offer(nativeEvents, rootIdle).pipe(
            Effect.andThen(Fiber.join(terminal)),
          );
          const settleWake = Queue.offer(nativeEvents, wakeIdle).pipe(
            Effect.andThen(Deferred.await(wakeIdleConsumed)),
          );
          const held = scenario === "held-wake" || scenario === "held-wake-settled";
          const settlesDuringAbort =
            scenario === "root-settled" || scenario === "held-wake-settled";
          let wake: Continuations.ProviderContinuationRequest | undefined;
          if (held) {
            yield* Queue.offer(nativeEvents, {
              type: "message.updated",
              properties: {
                sessionID: root.id,
                info: { id: promptId, sessionID: root.id, role: "user", time: { created: 1 } },
              },
            });
            yield* settleRoot;
            yield* Queue.offerAll(nativeEvents, [
              {
                type: "message.updated",
                properties: {
                  sessionID: root.id,
                  info: { id: "held-wake", sessionID: root.id, role: "user", time: { created: 2 } },
                },
              },
              {
                type: "session.status",
                properties: { sessionID: root.id, status: { type: "busy" } },
              },
            ]);
            wake = yield* Deferred.await(offeredWake);
            assert.isTrue(Option.isSome(yield* wake.dispatchIfCurrent!(Effect.void)));
          }
          const stopping = yield* runtime
            .interruptTurn({
              providerThread,
              providerTurnId: turn.id,
              requestRuntimeRestart: true,
            })
            .pipe(Effect.result, Effect.forkChild);
          const rootSignal = yield* Effect.promise(() => abortRoot.promise);
          const settleDuringStop = held ? settleWake : settleRoot;
          if (settlesDuringAbort) yield* settleDuringStop;
          if (wake !== undefined)
            assert.isTrue(Option.isNone(yield* wake.dispatchIfCurrent!(Effect.void)));
          yield* TestClock.adjust("10 seconds");
          assert.isTrue(rootSignal.aborted);
          if (!settlesDuringAbort) {
            assert.isDefined(
              stopping.pollUnsafe(),
              "the root timeout must reach the caller at ten seconds",
            );
            assert.nestedInclude(yield* Fiber.join(stopping), {
              "failure._tag": "ProviderAdapterInterruptTimeoutError",
              "failure.timeoutMs": 10_000,
            });
            yield* settleDuringStop;
          }
          const childSignal = yield* Effect.promise(() => abortChild.promise);
          const replacement = yield* start(2).pipe(Effect.forkChild);
          yield* TestClock.adjust("5 seconds");
          assert.isFalse(childSignal.aborted, "the manager watchdog must leave cleanup running");
          assert.equal(prompts, 1, "cleanup still owns admission to the next turn");
          if (settlesDuringAbort) assert.isUndefined(stopping.pollUnsafe());
          yield* TestClock.adjust("5 seconds");
          assert.isTrue(childSignal.aborted);
          if (settlesDuringAbort) {
            assert.nestedInclude(yield* Fiber.join(stopping), {
              "failure._tag": "ProviderAdapterInterruptError",
              "failure.cause._tag": "TimeoutError",
            });
          }
          yield* Fiber.join(replacement);
          assert.equal(prompts, 2);
        }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, adapterRegistryLayer })));
      }),
  );

  it.effect.each(
    (
      [
        ["opencode2_subagent", "session.execution.started.2"],
        ["opencode2_background", "session.execution.started.3"],
      ] as const
    ).flatMap(([fixtureName, label]) => {
      const fixture = findReplayFixture(fixtureName);
      const provider = fixture?.providers[0];
      return fixture === undefined || provider === undefined
        ? []
        : [[fixtureName, label, fixture, provider] as const];
    }),
  )(
    "runs %s when %s is an execution start this build cannot decode",
    ([fixtureName, label, fixture, provider]) =>
      runOpenCodeReplayFixture({
        fixtureName,
        buildInput: fixture.buildInput,
        driver: provider,
        transformTranscript: (transcript) => ({
          ...transcript,
          entries: transcript.entries.map((entry) =>
            entry.type === "emit_inbound" && entry.label === label
              ? undecodableEvent(entry)
              : entry,
          ),
        }),
      }),
  );
});

function undecodableEvent(entry: ProviderReplayEntry): ProviderReplayEntry {
  if (entry.type !== "emit_inbound") return entry;
  const frame = entry.frame as { readonly event: Record<string, unknown> };
  return { ...entry, frame: { ...frame, event: { ...frame.event, durable: "not-an-envelope" } } };
}
