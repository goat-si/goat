import { expect, it } from "@effect/vitest";
import { EventId, MessageId, NodeId, RunId, TurnItemId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import {
  createD10Thread,
  D10_NOW,
  layerTest,
  modelSelection,
  providerInstanceId,
  saveD10Item,
} from "./ProjectionStore.testkit.ts";
import {
  encodeThreadHistoryCursor,
  THREAD_HISTORY_INLINE_WORK_ITEM_LIMIT,
} from "./threadHistoryPaging.ts";

it.layer(layerTest)("mid-turn message projection", (it) => {
  it.effect("keeps only message.show results inline when a settled turn defers work", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const threadId = yield* createD10Thread("mid-turn");
      const runId = RunId.make("run:mid-turn");
      const rootNodeId = NodeId.make("node:mid-turn");
      const userMessageId = MessageId.make("message:mid-turn");
      yield* store.apply({
        id: EventId.make("event:mid-turn:run"),
        type: "run.updated",
        threadId,
        runId,
        occurredAt: D10_NOW,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId,
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: D10_NOW,
          startedAt: D10_NOW,
          completedAt: D10_NOW,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const base = {
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed" as const,
        title: null,
        startedAt: D10_NOW,
        completedAt: D10_NOW,
        updatedAt: D10_NOW,
      };
      yield* saveD10Item({
        ...base,
        id: TurnItemId.make("turn-item:mid-turn:prompt"),
        ordinal: 1,
        type: "user_message",
        messageId: userMessageId,
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        text: "Draft a reply.",
        attachments: [],
      });
      const lastOrdinal = THREAD_HISTORY_INLINE_WORK_ITEM_LIMIT + 5;
      const rejected = [
        {
          toolName: "mcp__foreign__goat_message_show",
          input: {},
          output: { sentMessage: "This tool is not GOAT." },
        },
        {
          toolName: "mcp__goat__goat_call",
          input: { path: "message.show", name: "thread.read" },
          output: { status: "ok", value: { sentMessage: "The aliases conflict." } },
        },
        {
          toolName: "mcp__goat__goat_message_show",
          input: { sentMessage: "This is input, not a result." },
          output: { isError: true },
        },
      ];
      for (let ordinal = 2; ordinal <= lastOrdinal; ordinal++) {
        const target = ordinal === 3 ? { path: "message.show" } : { path: "thread.read" };
        yield* saveD10Item({
          ...base,
          id: TurnItemId.make(`turn-item:mid-turn:${ordinal}`),
          ordinal,
          type: "dynamic_tool",
          toolName: "mcp__goat__goat_call",
          input: target,
          output: ordinal <= 4 ? { status: "ok", value: { sentMessage: "**Draft**" } } : {},
          ...rejected[ordinal - 5],
        });
      }
      const window = yield* store.getThreadSnapshotWindow(threadId, {
        rowLimit: 80,
        userTurnLimit: 10,
        deferWork: true,
      });
      const rows = window.projection.visibleTurnItems;
      expect(rows.find((row) => row.item.ordinal === 2)?.item.deferredWork?.itemCount).toBe(
        lastOrdinal - 2,
      );
      expect(rows.find((row) => row.item.ordinal === 3)?.item).toMatchObject({
        output: { status: "ok", value: { sentMessage: "**Draft**" } },
      });
      expect(rows.some((row) => row.item.ordinal === 4)).toBe(false);
      expect(rows.filter((row) => row.item.ordinal >= 5 && row.item.ordinal <= 7)).toEqual([]);

      const cursor = encodeThreadHistoryCursor({
        snapshotSequence: window.snapshotSequence,
        sourceThreadId: threadId,
        sourceItemId: `turn-item:mid-turn:${lastOrdinal}`,
        position: lastOrdinal - 1,
      });
      const page = yield* store.getThreadHistoryPage(
        threadId,
        cursor,
        undefined,
        false,
        "deferred",
      );
      expect(page.items.find((row) => row.item.ordinal === 3)?.item.deferredWork).toBeUndefined();
      expect(page.items.some((row) => row.item.ordinal === 3)).toBe(true);
      expect(page.items.some((row) => row.item.ordinal === 4)).toBe(false);
      expect(page.items.filter((row) => row.item.ordinal >= 5 && row.item.ordinal <= 7)).toEqual(
        [],
      );
    }),
  );
});
