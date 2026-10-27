import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2StoredEvent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { runResumableReactor, supervise } from "./backgroundSupervision.ts";
import { runUpdateReactors } from "./orchestration-v2/runUpdateReactors.ts";

it.effect("reopens a failed reactor at its last handled sequence", () =>
  Effect.gen(function* () {
    const failed = yield* Deferred.make<void>();
    const handled: number[] = [];
    const cursors: number[] = [];
    const fiber = yield* runResumableReactor(
      "test.reactor",
      10,
      (cursor) => {
        cursors.push(cursor);
        return cursors.length === 1
          ? Stream.concat(
              Stream.make({ sequence: 11 }),
              Stream.fromEffect(
                Deferred.succeed(failed, undefined).pipe(Effect.andThen(Effect.die("lost"))),
              ),
            )
          : Stream.concat(Stream.make({ sequence: 12 }), Stream.never);
      },
      (event) =>
        Effect.sync(() => {
          handled.push(event.sequence);
        }),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(failed);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(cursors, [10, 11]);
    assert.deepEqual(handled, [11, 12]);
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust("1 minute");
    assert.deepEqual(cursors, [10, 11]);
  }).pipe(Effect.scoped),
);

it.effect.each(["EOF", "failure"] as const)(
  "reopens after %s before any event and releases the old subscription before backoff",
  (outcome) =>
    Effect.gen(function* () {
      const opened = yield* Queue.unbounded<void>();
      const cursors: number[] = [];
      let active = 0;
      const fiber = yield* runResumableReactor(
        "test.empty",
        10,
        (cursor) =>
          Stream.unwrap(
            Effect.gen(function* () {
              cursors.push(cursor);
              active++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  active--;
                }),
              );
              yield* Queue.offer(opened, undefined);
              return outcome === "EOF" ? Stream.empty : Stream.fail("read unavailable");
            }),
          ),
        () => Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Queue.take(opened);
      yield* TestClock.adjust("999 millis");
      assert.deepEqual(cursors, [10]);
      assert.strictEqual(active, 0);
      yield* TestClock.adjust("1 milli");
      assert.deepEqual(cursors, [10, 10]);
      assert.strictEqual(active, 0);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
);

it.effect("replays an event whose handler failed without advancing its cursor", () =>
  Effect.gen(function* () {
    const attempted = yield* Deferred.make<void>();
    const cursors: number[] = [];
    const handled: number[] = [];
    let failed = false;
    const fiber = yield* runResumableReactor(
      "test.handler",
      10,
      (cursor) => {
        cursors.push(cursor);
        return Stream.concat(Stream.make({ sequence: 11 }), Stream.never);
      },
      (event) =>
        Effect.gen(function* () {
          if (!failed) {
            failed = true;
            yield* Deferred.succeed(attempted, undefined);
            return yield* Effect.fail("handler unavailable");
          }
          handled.push(event.sequence);
        }),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(attempted);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(cursors, [10, 10]);
    assert.deepEqual(handled, [11]);
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.scoped),
);

it.effect("caps repeated supervision backoff at thirty seconds and stops on interruption", () =>
  Effect.gen(function* () {
    const attempted = yield* Queue.unbounded<void>();
    let attempts = 0;
    let releases = 0;
    const fiber = yield* supervise("test.backoff", () =>
      Effect.gen(function* () {
        attempts++;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releases++;
          }),
        );
        yield* Queue.offer(attempted, undefined);
        return yield* Effect.fail("unavailable");
      }),
    ).pipe(Effect.forkScoped);
    yield* Queue.take(attempted);
    let expected = 1;
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      yield* TestClock.adjust(delay - 1);
      assert.strictEqual(attempts, expected);
      assert.strictEqual(releases, expected);
      yield* TestClock.adjust(1);
      expected++;
      assert.strictEqual(attempts, expected);
      assert.strictEqual(releases, expected);
    }
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust("1 minute");
    assert.strictEqual(attempts, expected);
  }).pipe(Effect.scoped),
);

it.effect("interrupts an active supervised attempt and releases its scope without retrying", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let attempts = 0;
    let releases = 0;
    const fiber = yield* supervise("test.interrupt", () =>
      Effect.gen(function* () {
        attempts++;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releases++;
          }),
        );
        yield* Deferred.succeed(started, undefined);
        yield* Effect.never;
      }),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust("1 minute");
    assert.strictEqual(attempts, 1);
    assert.strictEqual(releases, 1);
  }).pipe(Effect.scoped),
);

it.effect("ends a one-shot repair after success", () =>
  Effect.gen(function* () {
    const attempted = yield* Deferred.make<void>();
    let attempts = 0;
    const fiber = yield* supervise(
      "test.repair",
      () =>
        Effect.gen(function* () {
          if (++attempts === 1) {
            yield* Deferred.succeed(attempted, undefined);
            return yield* Effect.fail("unavailable");
          }
        }),
      { restartOnSuccess: false },
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(attempted);
    yield* TestClock.adjust("1 second");
    assert.strictEqual(attempts, 2);
    yield* Fiber.join(fiber);
    yield* TestClock.adjust("1 minute");
    assert.strictEqual(attempts, 2);
  }).pipe(Effect.scoped),
);

const reactorEvent = (
  type: "run.updated" | "provider-thread.updated" | "subagent.updated",
  sequence: number,
  now: DateTime.Utc,
): OrchestrationV2StoredEvent => {
  const threadId = ThreadId.make("thread:reactor");
  const instanceId = ProviderInstanceId.make("codex");
  const providerThreadId = ProviderThreadId.make("provider-thread:reactor");
  const common = { id: EventId.make(`event:${sequence}`), threadId, occurredAt: now };
  const envelope = { sequence, commandId: null };
  switch (type) {
    case "run.updated":
      return {
        ...envelope,
        event: {
          ...common,
          type,
          payload: {
            id: RunId.make("run:reactor"),
            threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "gpt-5.1-codex" },
            providerThreadId,
            userMessageId: MessageId.make("message:reactor"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      };
    case "provider-thread.updated":
      return {
        ...envelope,
        event: {
          ...common,
          type,
          payload: {
            id: providerThreadId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      };
    case "subagent.updated":
      return {
        ...envelope,
        event: {
          ...common,
          type,
          payload: {
            id: NodeId.make("node:reactor"),
            threadId,
            runId: null,
            parentNodeId: NodeId.make("node:parent"),
            origin: "provider_native",
            createdBy: "agent",
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: instanceId,
            providerThreadId,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "task",
            title: null,
            model: null,
            status: "completed",
            result: "done",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        },
      };
  }
};

it.effect("replays updates committed during backoff using independent event-type cursors", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const opened = yield* Queue.unbounded<void>();
    const cursors = {
      "run.updated": [] as number[],
      "provider-thread.updated": [] as number[],
      "subagent.updated": [] as number[],
    };
    const sequences = { "run.updated": 30, "provider-thread.updated": 20, "subagent.updated": 11 };
    const eventTypes = ["run.updated", "provider-thread.updated", "subagent.updated"] as const;
    const journal = eventTypes.map((type) => reactorEvent(type, sequences[type], now));
    const handled: number[] = [];
    const children: number[] = [];
    const fiber = yield* runUpdateReactors({
      afterSequence: 10,
      stream: ({ eventType, afterSequence }) => {
        const history = cursors[eventType];
        history.push(afterSequence);
        const replay = Stream.fromIterable(
          journal.filter(
            (event) => event.event.type === eventType && event.sequence > afterSequence,
          ),
        );
        if (history.length === 1) {
          return Stream.concat(
            replay,
            Stream.fromEffect(
              Queue.offer(opened, undefined).pipe(
                Effect.andThen(Effect.fail("replay read failed")),
              ),
            ),
          );
        }
        return Stream.concat(replay, Stream.never);
      },
      handleRun: (event) =>
        Effect.sync(() => {
          handled.push(event.sequence);
        }),
      handleChild: (event) =>
        Effect.sync(() => {
          children.push(event.sequence);
        }),
    }).pipe(Effect.forkScoped);
    yield* Queue.take(opened);
    yield* Queue.take(opened);
    yield* Queue.take(opened);
    for (const type of eventTypes) journal.push(reactorEvent(type, sequences[type] + 100, now));
    yield* TestClock.adjust("1 second");
    assert.deepEqual(cursors, {
      "run.updated": [10, 30],
      "provider-thread.updated": [10, 20],
      "subagent.updated": [10, 11],
    });
    assert.deepEqual(handled, [30, 130]);
    assert.deepEqual(
      children.toSorted((left, right) => left - right),
      [11, 20, 111, 120],
    );
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust("1 minute");
    assert.deepEqual(handled, [30, 130]);
  }).pipe(Effect.scoped),
);
