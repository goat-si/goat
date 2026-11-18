import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, RunId, type OrchestrationV2StoredEvent } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { runEvent } from "./DelegatedCompletionDelivery.testkit.ts";
import { runUpdateReactors } from "./runUpdateReactors.ts";

it.effect("a blocked terminal reaction leaves another thread free and preserves FIFO", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const reacted = yield* Queue.unbounded<number>();
    const blocked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const now = yield* DateTime.now;
    const child = ThreadId.make("thread:terminal-busy");
    const other = ThreadId.make("thread:terminal-independent");
    const event = (threadId: ThreadId, sequence: number) => ({
      sequence,
      commandId: CommandId.make(`provider:terminal-${sequence}`),
      event: runEvent({
        threadId,
        runId: RunId.make(`run:terminal-${sequence}`),
        ordinal: sequence,
        status: "completed",
        now,
      }),
    });
    yield* runUpdateReactors({
      afterSequence: 0,
      stream: ({ eventType }) =>
        eventType === "run.updated" ? Stream.fromQueue(events) : Stream.never,
      handleRun: ({ sequence }) =>
        (sequence === 1
          ? Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void
        ).pipe(Effect.andThen(Queue.offer(reacted, sequence))),
      handleChild: () => Effect.void,
    }).pipe(Effect.forkScoped);
    yield* Queue.offer(events, event(child, 1));
    yield* Deferred.await(blocked);
    yield* Queue.offer(events, event(child, 2));
    yield* Queue.offer(events, event(other, 3));
    assert.equal(yield* Queue.take(reacted), 3);
    yield* Deferred.succeed(release, undefined);
    assert.equal(yield* Queue.take(reacted), 1);
    assert.equal(yield* Queue.take(reacted), 2);
  }),
);

it.effect("replays a saturated thread's journal after an independent reaction runs", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const reacted = yield* Queue.unbounded<number>();
    const blocked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const now = yield* DateTime.now;
    const busy = ThreadId.make("thread:journal-busy");
    const other = ThreadId.make("thread:journal-healthy");
    const entries = Array.from({ length: 131 }, (_, index) => {
      const sequence = index + 1;
      return {
        sequence,
        commandId: CommandId.make(`provider:journal-${sequence}`),
        event: runEvent({
          threadId: sequence === 131 ? other : busy,
          runId: RunId.make(`run:journal-${sequence}`),
          ordinal: sequence,
          status: "completed",
          now,
        }),
      };
    });
    yield* runUpdateReactors({
      afterSequence: 0,
      stream: ({ eventType, afterSequence, throughSequence, threadId }) => {
        if (eventType !== "run.updated") return Stream.never;
        return throughSequence === undefined
          ? Stream.fromQueue(events)
          : Stream.fromIterable(
              entries.filter(
                ({ event, sequence }) =>
                  event.threadId === threadId &&
                  sequence > afterSequence &&
                  sequence <= throughSequence,
              ),
            );
      },
      handleRun: ({ sequence }) =>
        (sequence === 1
          ? Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void
        ).pipe(Effect.andThen(Queue.offer(reacted, sequence))),
      handleChild: () => Effect.void,
    }).pipe(Effect.forkScoped);
    const first = entries[0];
    assert.isDefined(first);
    yield* Queue.offer(events, first);
    yield* Deferred.await(blocked);
    yield* Queue.offerAll(events, entries.slice(1));
    assert.equal(yield* Queue.take(reacted), 131);
    yield* Deferred.succeed(release, undefined);
    for (let sequence = 1; sequence < 131; sequence++) {
      assert.equal(yield* Queue.take(reacted), sequence);
    }
  }),
);
