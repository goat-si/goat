import { assert, describe, it } from "@effect/vitest";
import { MessageId, type OrchestrationV2ThreadHistoryPage } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  layerTest,
  createProject,
  thread,
  threadId,
  projectId,
  item,
  run,
  commit,
  putItems,
} from "./ThreadFind.testkit.ts";
import {
  encodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_PAGE_POLICY,
} from "./threadHistoryPaging.ts";
import { projectTurnItemForWire } from "./WireProjection.ts";

const setup = Effect.gen(function* () {
  yield* createProject(projectId);
  yield* commit([thread(threadId, projectId), run()]);
  return yield* ProjectionStore.ProjectionStoreV2;
});

describe("V2 history materialization", () => {
  it.effect(
    "combines history pages through a match's message identity without skipping intervening turns",
    () =>
      Effect.gen(function* () {
        const projection = yield* setup;
        const items = Array.from({ length: 45 }, (_, turn) => [
          item(`user:${turn}`, turn * 3, `turn ${turn}`, "user_message"),
          {
            ...item(`answer:${turn}`, turn * 3 + 1, `answer ${turn}`),
            messageId: MessageId.make(`message:${turn}`),
          },
          {
            ...item(`tool:${turn}`, turn * 3 + 2, ""),
            type: "command_execution" as const,
            input: "pwd",
            output: "huge output".repeat(1000),
            exitCode: 0,
          },
        ]).flat();
        yield* putItems(items);
        const snapshot = yield* projection.getThreadSnapshot(threadId);
        const cursor = encodeThreadHistoryCursor({
          snapshotSequence: snapshot.snapshotSequence,
          sourceThreadId: threadId,
          sourceItemId: "absent",
          position: items.length,
        });
        const ordinary = yield* projection.getThreadHistoryPage(threadId, cursor);
        assert.equal(ordinary.items[0]?.sourceItemId, "user:25");
        const targeted = yield* projection.getThreadHistoryPage(threadId, cursor, "message:10");
        assert.equal(targeted.items[0]?.sourceItemId, "user:10");
        assert.deepEqual(
          targeted.items.map((row) => row.sourceItemId),
          items.slice(30).map((entry) => entry.id),
        );
        const conversation = yield* projection.getThreadHistoryPage(
          threadId,
          cursor,
          "message:10",
          true,
        );
        assert.equal(conversation.nextCursor, targeted.nextCursor);
        assert.equal(conversation.hasMoreHistory, targeted.hasMoreHistory);
        assert.deepEqual(
          conversation.items.map((row) => row.sourceItemId),
          targeted.items
            .filter((row) => row.item.type !== "command_execution")
            .map((row) => row.sourceItemId),
        );
        assert.equal(conversation.items.length, 70);
        assert.equal(targeted.items.length, 105);
        assert.isTrue(targeted.hasMoreHistory);
        const earlier = yield* projection.getThreadHistoryPage(threadId, targeted.nextCursor!);
        assert.deepEqual(
          earlier.items.map((row) => row.sourceItemId),
          items.slice(0, 30).map((entry) => entry.id),
        );
        assert.isFalse(earlier.hasMoreHistory);
        const capped = yield* projection.getThreadHistoryPage(threadId, cursor, "message:0");
        assert.equal(capped.items[0]?.sourceItemId, "user:5");
        const absent = yield* projection.getThreadHistoryPage(
          threadId,
          cursor,
          "another-thread-message",
        );
        assert.deepEqual(absent, ordinary);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("pages long turns without duplicating or skipping messages", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const items = Array.from({ length: 45 }, (_, turn) => [
        item(`user:${turn}`, turn * 3, `turn ${turn}`, "user_message"),
        {
          ...item(`steer:${turn}`, turn * 3 + 1, "steer", "user_message"),
          inputIntent: "steer" as const,
        },
        item(
          `answer:${turn}`,
          turn * 3 + 2,
          turn === 40 ? "large ".repeat(200_000) : `answer ${turn}`,
        ),
      ]).flat();
      yield* putItems(items);
      const snapshot = yield* projection.getThreadSnapshot(threadId);
      const rows = snapshot.projection.visibleTurnItems.map((row) => ({
        ...row,
        item: projectTurnItemForWire(row.item),
      }));
      let cursor: string | null = encodeThreadHistoryCursor({
        snapshotSequence: snapshot.snapshotSequence,
        sourceThreadId: threadId,
        sourceItemId: "absent",
        position: rows.length,
      });
      const collected: string[] = [];
      while (cursor !== null) {
        const page: OrchestrationV2ThreadHistoryPage = yield* projection.getThreadHistoryPage(
          threadId,
          cursor,
        );
        assert.deepEqual(page, {
          snapshotSequence: snapshot.snapshotSequence,
          ...selectHistoryPageFromCursor({
            items: rows,
            cursor,
            snapshotSequence: snapshot.snapshotSequence,
          }),
        });
        // A turn larger than the byte budget is split, but only a lone oversized item may exceed it.
        assert.isTrue(
          page.items.length === 1 ||
            Buffer.byteLength(JSON.stringify(page.items), "utf8") <=
              THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
        );
        collected.unshift(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.nextCursor;
      }
      assert.deepEqual(
        collected,
        items.map((entry) => String(entry.id)),
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("enforces fallback item and byte limits and always admits an oversized row", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems(
        Array.from({ length: 80 }, (_, ordinal) =>
          item(`row:${ordinal}`, ordinal, ordinal < 78 ? "small" : "large ".repeat(200_000)),
        ),
      );
      const snapshot = yield* projection.getThreadSnapshot(threadId);
      const rows = snapshot.projection.visibleTurnItems.map((row) => ({
        ...row,
        item: projectTurnItemForWire(row.item),
      }));
      let cursor: string | null = encodeThreadHistoryCursor({
        snapshotSequence: snapshot.snapshotSequence,
        sourceThreadId: threadId,
        sourceItemId: "absent",
        position: rows.length,
      });
      const sizes: number[] = [];
      while (cursor !== null) {
        const page: OrchestrationV2ThreadHistoryPage = yield* projection.getThreadHistoryPage(
          threadId,
          cursor,
        );
        assert.deepEqual(page, {
          snapshotSequence: snapshot.snapshotSequence,
          ...selectHistoryPageFromCursor({
            items: rows,
            cursor,
            snapshotSequence: snapshot.snapshotSequence,
          }),
        });
        sizes.push(page.items.length);
        cursor = page.nextCursor;
      }
      assert.deepEqual(sizes, [1, 1, 75, 3]);
    }).pipe(Effect.provide(layerTest)),
  );
});
