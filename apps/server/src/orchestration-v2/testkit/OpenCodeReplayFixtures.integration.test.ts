import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId, type ProviderReplayEntry } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as OpenCodeRuntime from "@goat/provider-opencode/server/OpenCodeRuntime";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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

  it.effect.each(["root-running", "root-settled"] as const)(
    "separates the OpenCode 1.x root Stop deadline from child cleanup when %s",
    (scenario) =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const nativeEvents = yield* Queue.unbounded<unknown>();
        const root = { id: "root", time: { created: 1, updated: 1 } };
        const abortRoot = Promise.withResolvers<AbortSignal>();
        const abortChild = Promise.withResolvers<AbortSignal>();
        const unanswered = Promise.withResolvers<never>();
        let prompts = 0;
        const client = {
          mcp: { add: async () => ({ data: true }) },
          event: {
            subscribe: async () => ({
              stream: Stream.toAsyncIterable(Stream.fromQueue(nativeEvents)),
            }),
          },
          session: {
            create: async () => ({ data: root }),
            get: async () => ({ data: root }),
            messages: async () => ({ data: [] }),
            promptAsync: async () => {
              prompts++;
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
        ).pipe(Layer.orDie);
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
          const settleRoot = Queue.offer(nativeEvents, {
            type: "session.idle",
            properties: { sessionID: root.id },
          }).pipe(Effect.andThen(Fiber.join(terminal)));
          const stopping = yield* runtime
            .interruptTurn({
              providerThread,
              providerTurnId: turn.id,
              requestRuntimeRestart: true,
            })
            .pipe(Effect.result, Effect.forkChild);
          const rootSignal = yield* Effect.promise(() => abortRoot.promise);
          if (scenario === "root-settled") yield* settleRoot;
          yield* TestClock.adjust("10 seconds");
          assert.isTrue(rootSignal.aborted);
          if (scenario === "root-running") {
            assert.isDefined(
              stopping.pollUnsafe(),
              "the root timeout must reach the caller at ten seconds",
            );
            assert.nestedInclude(yield* Fiber.join(stopping), {
              "failure._tag": "ProviderAdapterInterruptTimeoutError",
              "failure.timeoutMs": 10_000,
            });
            yield* settleRoot;
          }
          const childSignal = yield* Effect.promise(() => abortChild.promise);
          const replacement = yield* start(2).pipe(Effect.forkChild);
          yield* TestClock.adjust("5 seconds");
          assert.isFalse(childSignal.aborted, "the manager watchdog must leave cleanup running");
          assert.equal(prompts, 1, "cleanup still owns admission to the next turn");
          if (scenario === "root-settled") assert.isUndefined(stopping.pollUnsafe());
          yield* TestClock.adjust("5 seconds");
          assert.isTrue(childSignal.aborted);
          if (scenario === "root-settled") {
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
