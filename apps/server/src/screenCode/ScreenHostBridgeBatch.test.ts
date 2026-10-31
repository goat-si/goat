import { expect, it } from "@effect/vitest";
import type { EnvironmentId, ProviderInstanceId, ScreenHostCall, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { screenRunLimits } from "./ScreenRunLimits.ts";

const context = {
  runId: "r",
  turnId: "t",
  cellId: "c",
  threadId: "thread",
  environmentId: "env",
  limits: screenRunLimits({}),
  invocation: {
    environmentId: "env" as EnvironmentId,
    capabilities: new Set(["preview" as const]),
    issuedAt: 0,
    requestNamespace: "test",
    client: undefined,
    thread: {
      threadId: "thread" as ThreadId,
      providerSessionId: "s",
      providerInstanceId: "p" as ProviderInstanceId,
    },
  },
};
const app = {
  id: "window",
  kind: "app" as const,
  environmentId: "env",
  runId: "r",
  turnId: "t",
  generation: 0,
};
/** One of three clicks the prelude sent together as a batch group. */
const member = (callId: number): ScreenHostCall => ({
  t: "call",
  runId: "r",
  turnId: "t",
  cellId: "c",
  callId,
  targetRef: app,
  method: "click",
  args: [{ name: "Apply", batch: { index: callId - 1, size: 3 }, targetRef: app }],
  deadlineMillis: 60_000,
});

it.effect.each([
  ["the first", 1, [true, false, false]],
  ["a middle", 2, [true, true, false]],
] as const)(
  "a stop while %s member of a batch is pending leaves the later members unsent",
  ([, pendingCall, dispatched]) =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      const pending = yield* Deferred.make<void>();
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: (call) =>
          call.callId === pendingCall
            ? Deferred.succeed(pending, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed({ category: "confirmed" as const, evidence: ["clicked"] }),
      });
      const members = yield* Effect.forEach([1, 2, 3], (callId) =>
        bridge.handle(member(callId), context).pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Deferred.await(pending);
      bridge.cutCellNow("r", "t", "c");
      yield* Effect.forEach(members, Fiber.join);
      const journal = bridge.takeCellImagesNow("r", "t", "c").journal;
      expect(journal.map((entry) => entry.receipt.dispatched)).toEqual(dispatched);
    }),
);

it.effect("unawaited settled refusals remain refused while dispatched calls stay unknown", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    const started = yield* Deferred.make<void>();
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* bridge.handle(
      { ...member(1), method: "type_text", args: [{ text: "too long" }] },
      { ...context, limits: screenRunLimits({ argBytes: 4 }) },
    );
    yield* bridge
      .handle({ ...member(2), args: {} }, context)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    bridge.markUnawaitedNow("r", "t", "c", [1, 2]);
    const journal = bridge.takeCellImagesNow("r", "t", "c").journal;
    expect(journal[0]?.receipt).toMatchObject({
      category: "refused",
      journalState: "settled",
      dispatched: false,
    });
    expect(journal[1]?.receipt).toMatchObject({
      category: "unknown_outcome",
      journalState: "unknown",
      dispatched: true,
    });
    bridge.cutCellNow("r", "t", "c");
  }),
);

it.effect("cutting unawaited batch members prevents a later member from being sent", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const sent: number[] = [];
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: (call) =>
        Effect.gen(function* () {
          sent.push(call.callId);
          if (call.callId === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return { category: "confirmed" as const, evidence: ["clicked"] };
        }),
    });
    const calls = yield* Effect.forEach([1, 2, 3], (id) =>
      bridge.handle(member(id), context).pipe(Effect.forkChild({ startImmediately: true })),
    );
    yield* Deferred.await(started);
    bridge.markUnawaitedNow("r", "t", "c", [1, 2, 3]);
    const journal = bridge.takeCellImagesNow("r", "t", "c").journal;
    yield* Deferred.succeed(release, undefined);
    yield* Effect.forEach(calls, Fiber.join);
    expect(sent).toEqual([1]);
    expect(journal[0]?.receipt).toMatchObject({
      category: "unknown_outcome",
      journalState: "unknown",
      dispatched: true,
    });
    expect(journal[1]?.receipt).toMatchObject({
      category: "refused",
      journalState: "settled",
      dispatched: false,
    });
  }),
);

it.effect("unawaited queued call cannot dispatch after its cell completes", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const sent: number[] = [];
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: (item) =>
        Effect.gen(function* () {
          sent.push(item.callId);
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return { category: "confirmed" as const, evidence: ["done"] };
        }),
    });
    const first = yield* bridge
      .handle({ ...member(1), args: {} }, context)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    const second = yield* bridge
      .handle({ ...member(2), args: {} }, context)
      .pipe(Effect.forkChild({ startImmediately: true }));
    bridge.markUnawaitedNow("r", "t", "c", [2]);
    const journal = bridge.takeCellImagesNow("r", "t", "c").journal;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(sent).toEqual([1]);
    expect(journal[1]?.receipt).toMatchObject({
      category: "refused",
      journalState: "settled",
      dispatched: false,
    });
  }),
);
