import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  ProviderInstanceId,
  ProviderSessionId,
  RawEventId,
  ThreadId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as LiveModelSelection from "./LiveModelSelection.ts";

const selection = (effort: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: effort }],
});

const selectionChanged = (
  threadId: ThreadId,
  modelSelection: ModelSelection,
  reportedByProvider = false,
) =>
  ({
    id: EventId.make(`event:${threadId}:${String(modelSelection.options?.[0]?.value)}`),
    type: "thread.model-selection-updated",
    threadId,
    occurredAt: DateTime.makeUnsafe(0),
    ...(reportedByProvider ? { rawEventId: RawEventId.make("raw:model") } : {}),
    payload: { modelSelection },
  }) as unknown as OrchestrationV2DomainEvent;

type Apply = NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["applyModelSelection"]>;

/** Threads A and B run turns in their own sessions; "idle" has no running turn. */
const reactor = (applyModelSelection: Apply) =>
  LiveModelSelection.make().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRunningTurnContext: (threadId) =>
            Effect.succeed({
              run: undefined,
              providerThread: {
                id: `provider-thread:${threadId}`,
                providerSessionId: ProviderSessionId.make(`session:${threadId}`),
              } as unknown as OrchestrationV2ProviderThread,
              providerTurn: threadId === "idle" ? undefined : ({} as never),
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeedSome({
              applyModelSelection,
            } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
        }),
      ),
    ),
  );

const effortOf = (input: Parameters<Apply>[0]) =>
  `${input.providerThread.providerSessionId}:${String(input.modelSelection.options?.[0]?.value)}`;

it.effect("applies a person's change to the running turn and never the provider's own report", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const reachedB = yield* Deferred.make<void>();
    const { handle } = yield* reactor((input) =>
      Effect.suspend(() =>
        calls.push(effortOf(input)) > 0 && input.providerThread.providerSessionId === "session:b"
          ? Deferred.succeed(reachedB, undefined)
          : Effect.void,
      ),
    );
    // Drains start in event order, so a call for A or the idle thread would come before B's.
    yield* handle(selectionChanged(ThreadId.make("a"), selection("low"), true));
    yield* handle(selectionChanged(ThreadId.make("idle"), selection("low")));
    yield* handle(selectionChanged(ThreadId.make("b"), selection("medium")));
    yield* Deferred.await(reachedB);
    assert.deepEqual(calls, ["session:b:medium"]);
  }).pipe(Effect.scoped),
);

it.effect("a slow call on one thread does not hold another thread's change", () =>
  Effect.gen(function* () {
    const reachedB = yield* Deferred.make<void>();
    const { handle } = yield* reactor((input) =>
      input.providerThread.providerSessionId === "session:a"
        ? Effect.never
        : Deferred.succeed(reachedB, undefined),
    );
    yield* handle(selectionChanged(ThreadId.make("a"), selection("low")));
    yield* handle(selectionChanged(ThreadId.make("b"), selection("low")));
    yield* Deferred.await(reachedB);
  }).pipe(Effect.scoped),
);

it.effect("a call past its deadline or a failed call frees its thread for the next change", () =>
  Effect.gen(function* () {
    const calls: Array<Deferred.Deferred<void>> = [];
    for (let index = 0; index < 3; index++) calls.push(yield* Deferred.make<void>());
    let count = 0;
    const { handle } = yield* reactor(() => {
      const index = count++;
      return Deferred.succeed(calls[index]!, undefined).pipe(
        Effect.andThen(
          index === 0 ? Effect.never : index === 1 ? Effect.die("CLI went away") : Effect.void,
        ),
      );
    });
    const thread = ThreadId.make("a");
    yield* handle(selectionChanged(thread, selection("low")));
    yield* Deferred.await(calls[0]!);
    yield* TestClock.adjust("10 seconds");
    yield* handle(selectionChanged(thread, selection("medium")));
    yield* Deferred.await(calls[1]!);
    yield* handle(selectionChanged(thread, selection("high")));
    yield* Deferred.await(calls[2]!);
  }).pipe(Effect.scoped),
);

// regression (review P3-7): past 256 threads a change is dropped and logged once per fill.
it.effect("drops a change past 256 draining threads, warning once each time the table fills", () =>
  Effect.gen(function* () {
    const applied = new Set<string>();
    const release = yield* Deferred.make<void>();
    const allDone = yield* Deferred.make<void>();
    let blocking = true;
    const warnings: Array<string> = [];
    const { handle } = yield* reactor((input) =>
      Effect.sync(() => applied.add(String(input.providerThread.providerSessionId))).pipe(
        Effect.andThen(blocking ? Deferred.await(release) : Effect.void),
        Effect.andThen(
          Effect.suspend(() =>
            applied.size === 256 ? Deferred.succeed(allDone, undefined) : Effect.void,
          ),
        ),
      ),
    );
    const fill = (prefix: string) =>
      Effect.forEach(
        Array.from({ length: 258 }, (_, index) => ThreadId.make(`${prefix}${index}`)),
        (thread) => handle(selectionChanged(thread, selection("low"))),
        { discard: true },
      );
    const capture = Logger.layer(
      [
        Logger.make(
          ({ message }) =>
            void warnings.push(String(Array.isArray(message) ? message[0] : message)),
        ),
      ],
      { mergeWithExisting: false },
    );
    yield* fill("t").pipe(Effect.provide(capture));
    assert.deepEqual(warnings, ["orchestration-v2.live-model-selection-full"]);
    blocking = false;
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(allDone);
    yield* TestClock.adjust("1 millis");
    assert.isFalse(applied.has("session:t256"));
    assert.isFalse(applied.has("session:t257"));
    yield* fill("u").pipe(Effect.provide(capture));
    assert.lengthOf(warnings, 2);
  }).pipe(Effect.scoped),
);
