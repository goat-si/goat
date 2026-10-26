import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { threadLeaseUpdates } from "./ComputerUseLeaseThreadStream.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";

const threadId = ThreadId.make("thread:fenced");
const expiresAt = DateTime.makeUnsafe("2100-01-01T00:00:00.000Z");

it.effect("a control ended by a failed read is never advertised again when reads recover", () =>
  Effect.gen(function* () {
    const signals = yield* PubSub.unbounded<void>();
    const recovered = yield* Queue.unbounded<void>();
    let reads = 0;
    // The read that recovers answers for A; the stream's own recheck then still sees A, and
    // only the following wake finds B: no scheduling can merge the two.
    let latestCallsLeft = -1;
    const current = () => {
      if (latestCallsLeft > 0) latestCallsLeft--;
      return latestCallsLeft === 0 ? "control:b" : "control:a";
    };
    const context = yield* Layer.build(
      Layer.mergeAll(
        ServerSettings.layerTest({ enableCua: true }),
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          inspect: () => Effect.succeed({ threadId, recheckAt: Number.MAX_SAFE_INTEGER }),
          subscribeChanges: PubSub.unbounded<void>().pipe(Effect.flatMap(PubSub.subscribe)),
        }),
        Layer.mock(ComputerUseLeases.ComputerUseLeases)({
          proxy: undefined,
          subscribe: PubSub.subscribe(signals),
          streamOpened: () => Effect.void,
          releaseApps: () => Effect.void,
          currentControl: () =>
            Effect.sync(() => Option.some({ threadId, controlId: current(), expiresAt })),
          controlState: () =>
            Effect.suspend(() => {
              reads++;
              if (reads === 2)
                return Effect.fail(
                  new ComputerUseLeases.ComputerUseLeaseError({ cause: new Error("read failed") }),
                );
              if (reads === 3) latestCallsLeft = 2;
              return Queue.offer(recovered, undefined).pipe(
                Effect.as({
                  _tag: "active" as const,
                  expiresAt,
                  apps: undefined,
                  interruptions: { count: 0, last: "human_input" as const },
                  wakeAt: DateTime.toEpochMillis(expiresAt),
                }),
              );
            }),
        }),
      ),
    );
    const updates = yield* threadLeaseUpdates({ threadId, token: "fixture" }).pipe(
      Stream.provideContext(context),
      Stream.toQueue({ capacity: "unbounded" }),
    );
    const next = Queue.take(updates);
    assert.deepInclude(yield* next, { state: "active", controlId: "control:a" });
    yield* Queue.take(recovered);
    yield* PubSub.publish(signals, undefined);
    assert.deepEqual(yield* next, {
      state: "control-ended",
      controlId: "control:a",
      reason: "revoked",
    });
    assert.deepEqual(yield* next, { state: "waiting" });
    // Reads recover while A is still current: A stays ended.
    yield* PubSub.publish(signals, undefined);
    yield* Queue.take(recovered);
    yield* PubSub.publish(signals, undefined);
    assert.deepInclude(yield* next, { state: "active", controlId: "control:b" });
  }).pipe(Effect.scoped),
);
