import { assert, it } from "@effect/vitest";
import type { TerminalMetadataStreamEvent, TerminalSummary } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { terminalMetadataStream } from "./terminalMetadataStream.ts";

const summary: TerminalSummary = {
  threadId: "thread",
  terminalId: "terminal",
  cwd: "/fixture",
  worktreePath: null,
  status: "running",
  pid: 1,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: "shell",
  updatedAt: "2026-10-28T00:00:00.000Z",
};

it.effect("metadata coalescing preserves removals and unregisters on cancellation", () =>
  Effect.gen(function* () {
    const listenerReady =
      yield* Deferred.make<(event: TerminalMetadataStreamEvent) => Effect.Effect<void>>();
    const blocked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const seen = yield* Queue.unbounded<TerminalMetadataStreamEvent>();
    let unsubscribed = 0;
    let first = true;
    const fiber = yield* terminalMetadataStream((listener) =>
      Deferred.succeed(listenerReady, listener).pipe(
        Effect.andThen(listener({ type: "snapshot", terminals: [summary] })),
        Effect.as(() => {
          unsubscribed++;
        }),
      ),
    ).pipe(
      Stream.runForEach((event) => {
        if (first) {
          first = false;
          assert.deepEqual(event, { type: "snapshot", terminals: [summary] });
          return Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Deferred.await(release)));
        }
        return Queue.offer(seen, event);
      }),
      Effect.forkScoped,
    );
    const listener = yield* Deferred.await(listenerReady);
    yield* Deferred.await(blocked);
    yield* listener({ type: "remove", threadId: summary.threadId, terminalId: summary.terminalId });
    for (let count = 1; count <= 1000; count++) {
      yield* listener({
        type: "upsert",
        terminal: { ...summary, terminalId: "kept", label: `shell ${count}` },
      });
    }
    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(yield* Queue.take(seen), {
      type: "snapshot",
      terminals: [{ ...summary, terminalId: "kept", label: "shell 1000" }],
    });
    yield* Fiber.interrupt(fiber);
    assert.equal(unsubscribed, 1);
  }).pipe(Effect.scoped),
);

it.effect("metadata snapshots replace state and terminal keys keep threads distinct", () =>
  Effect.gen(function* () {
    const listenerReady =
      yield* Deferred.make<(event: TerminalMetadataStreamEvent) => Effect.Effect<void>>();
    const seen = yield* Queue.unbounded<TerminalMetadataStreamEvent>();
    const fiber = yield* terminalMetadataStream((listener) =>
      Deferred.succeed(listenerReady, listener).pipe(
        Effect.andThen(listener({ type: "snapshot", terminals: [summary] })),
        Effect.as(() => {}),
      ),
    ).pipe(
      Stream.runForEach((event) => Queue.offer(seen, event)),
      Effect.forkScoped,
    );
    const listener = yield* Deferred.await(listenerReady);
    assert.deepEqual(yield* Queue.take(seen), { type: "snapshot", terminals: [summary] });
    const left = { ...summary, threadId: "a:b", terminalId: "c" };
    const right = { ...summary, threadId: "a", terminalId: "b:c" };
    yield* listener({ type: "snapshot", terminals: [left, right] });
    assert.deepEqual(yield* Queue.take(seen), { type: "snapshot", terminals: [left, right] });
    yield* listener({ type: "remove", threadId: left.threadId, terminalId: left.terminalId });
    assert.deepEqual(yield* Queue.take(seen), { type: "snapshot", terminals: [right] });
    yield* listener({ type: "snapshot", terminals: [] });
    assert.deepEqual(yield* Queue.take(seen), { type: "snapshot", terminals: [] });
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.scoped),
);
