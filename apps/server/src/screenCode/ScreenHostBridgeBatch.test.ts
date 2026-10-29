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
