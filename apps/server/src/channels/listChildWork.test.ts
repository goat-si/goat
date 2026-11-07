import { assert, describe, it } from "@effect/vitest";
import { ChannelChildWork, ChannelChildWorkId, ChannelTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { listChildWork } from "./listChildWork.ts";
import { admit, makeLayer, seedWorker } from "./testkit/channelChildWorkFixture.ts";

const decodeChild = Schema.decodeUnknownSync(ChannelChildWork);

describe("listChildWork", () => {
  it.effect("returns only owned tasks and children and bounds recent records", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const admission = yield* admit("first");
      if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      const ledger = yield* ChannelLedger.ChannelLedger;
      for (let i = 0; i < 21; i++) {
        const record = decodeChild({
          ...admission.record,
          childWorkId: ChannelChildWorkId.make(`child-${i}`),
          ownerId: i === 20 ? "foreign" : "owner",
          createdAt: `2026-10-13T00:00:${String(i).padStart(2, "0")}.000Z`,
        });
        yield* store.admitReserved(record, 100);
      }
      const unknown = ChannelTaskId.make("unknown");
      const result = yield* listChildWork(ledger, store, "owner", { taskIds: [taskId, unknown] });
      assert.strictEqual(result.groups.length, 1);
      assert.strictEqual(result.groups[0]?.children.length, 19);
      assert.isTrue(result.groups[0]?.truncated);
      assert.isTrue(result.groups[0]?.children.every((child) => child.ownerId === "owner"));
      const foreign = yield* listChildWork(ledger, store, "other", { taskIds: [taskId] });
      assert.deepStrictEqual(foreign.groups, []);
    }).pipe(Effect.provide(makeLayer())),
  );
});
