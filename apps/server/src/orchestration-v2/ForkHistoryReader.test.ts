import { assert, it } from "@effect/vitest";
import { MessageId, TurnItemId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { makeForkHistoryReader } from "./ForkHistoryReader.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { createD10Thread, D10_NOW, layerTest, saveD10Item } from "./ProjectionStore.testkit.ts";

it.effect("bounds inherited history by items and bytes before retaining it", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* createD10Thread("bounded-fork-history");
    const latestId = TurnItemId.make("bounded-fork-history:latest");
    const save = (id: TurnItemId, ordinal: number, text: string) =>
      saveD10Item({
        id,
        threadId,
        ordinal,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        type: "assistant_message",
        messageId: MessageId.make(id),
        text,
        streaming: false,
        status: "completed",
        title: null,
        startedAt: D10_NOW,
        completedAt: D10_NOW,
        updatedAt: D10_NOW,
      });
    for (let index = 0; index < 350; index++) {
      yield* save(TurnItemId.make(`bounded-fork-history:${index}`), index + 1, "small history row");
    }
    yield* save(TurnItemId.make("bounded-fork-history:oversized"), 351, "界".repeat(100_000));
    yield* save(latestId, 352, "latest small history row");
    const thread = yield* store.getThread(threadId);
    const items = yield* makeForkHistoryReader(store).readOwnItems(
      {
        thread: { ...thread, historyOrigin: "v1_import" },
      },
      1,
    );
    assert.isAtMost(items.length, 256);
    assert.isAtMost(Buffer.byteLength(JSON.stringify(items)), 256 * 1024);
    assert.equal(items.at(-1)?.id, latestId);
    assert.deepEqual(
      items.map((item) => item.ordinal),
      items.map((item) => item.ordinal).toSorted((a, b) => a - b),
    );
  }).pipe(Effect.provide(layerTest)),
);
