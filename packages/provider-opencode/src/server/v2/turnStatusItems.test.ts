import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ActiveTurn, ThreadState } from "./adapterState.ts";
import { makeTurnStatusItems } from "./turnStatusItems.ts";

it.effect("completed compaction clears pre-compaction usage; failed compaction preserves it", () =>
  Effect.gen(function* () {
    for (const status of ["completed", "failed"] as const) {
      const published: Array<unknown> = [];
      const state = { providerThread: { contextUsage: { usedTokens: 150_000 } } } as ThreadState;
      const turn = {
        compaction: { nativeId: "compact", startedAt: DateTime.makeUnsafe(0) },
        input: { rootNodeId: null },
        lastStep: { input: 150_000 },
      } as unknown as ActiveTurn;
      const items = makeTurnStatusItems({
        driver: ProviderDriverKind.make("opencode"),
        emit: () => Effect.void,
        emitProviderThread: (updated) =>
          Effect.sync(() => {
            published.push(updated.providerThread.contextUsage);
          }),
        ordinalOf: () => 0,
        itemBase: () => ({}) as never,
      });
      yield* items.emitCompaction(state, turn, status);
      if (status === "completed") {
        assert.isUndefined(turn.lastStep);
        assert.isNull(state.providerThread.contextUsage);
        assert.deepEqual(published, [null]);
      } else {
        assert.isDefined(turn.lastStep);
        assert.deepEqual(state.providerThread.contextUsage, { usedTokens: 150_000 });
        assert.deepEqual(published, []);
      }
    }
  }),
);
