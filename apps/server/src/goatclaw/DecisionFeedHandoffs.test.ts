import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  NodeId,
  OrchestrationV2TurnItemJson,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type DecisionFeed as DecisionFeedValue,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Feed from "./DecisionFeed.ts";
import type * as Inbox from "./DecisionInbox.ts";
import { fixture, seedThread } from "./DecisionDestination.testkit.ts";
import { MAX_FEED_HANDOFFS, openApprovalHandoffs } from "./openApprovalHandoffs.ts";

const encodeItem = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const defaultCreatedAt = DateTime.makeUnsafe("2026-11-11T08:00:00Z");
const createdAt = defaultCreatedAt;
const client: Inbox.DecisionCaller = {
  kind: "client",
  sessionId: "owner",
  environmentId: EnvironmentId.make("test"),
  scopes: ["orchestration:operate"],
};

const approvalItem = (
  threadId: string,
  id: string,
  state: "pending" | "completed",
  createdAt = defaultCreatedAt,
): Extract<OrchestrationV2TurnItem, { type: "human_handoff" }> => {
  const handoffId = TurnItemId.make(id);
  return {
    id: handoffId,
    threadId: ThreadId.make(threadId),
    runId: null,
    nodeId: NodeId.make("node:approval"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: state === "pending" ? "waiting" : "completed",
    title: null,
    startedAt: createdAt,
    updatedAt: createdAt,
    completedAt: null,
    type: "human_handoff",
    handoff: {
      handoffId,
      kind: "approval",
      title: "Join pen-lidge to the hub",
      reason: "Its model requests will go through this Mac.",
      requestedBy: {
        threadId: ThreadId.make(threadId),
        providerInstanceId: ProviderInstanceId.make("codex"),
        path: "hub.device_join",
      },
      target: { environmentId: EnvironmentId.make("test"), path: "hub.device_join" },
      dedupeKey: "dedupe",
      state,
      expiresAt: null,
      createdAt,
      actor: { type: "agent", threadId: ThreadId.make(threadId) },
    },
  };
};

const writeItem = (item: OrchestrationV2TurnItem) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${item.id}, ${item.threadId}, 1, ${item.type}, ${item.status}, '2026-11-11T08:00:00.000Z', ${encodeItem(item)})`;
  });

const handoffEvent = (
  item: OrchestrationV2TurnItem,
  sequence: number,
): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event: {
    id: EventId.make(`event:${sequence}`),
    type: "turn-item.updated",
    threadId: item.threadId,
    runId: undefined,
    occurredAt: createdAt,
    payload: item,
  },
});

it.effect("an open approval handoff is in the decision feed until a person answers it", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const sinkLayer = Layer.mock(EventSink.EventSinkV2)({
      latestSequence: () => Effect.succeed(0),
      stream: (input) =>
        Stream.fromEffect(input?.onSubscribed ?? Effect.void).pipe(
          Stream.drain,
          Stream.concat(Stream.fromQueue(events)),
        ),
    });
    yield* Effect.gen(function* () {
      yield* seedThread("asking");
      yield* seedThread("archived");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = '2026-11-11T07:00:00.000Z' WHERE thread_id = 'archived'`;
      yield* writeItem(approvalItem("archived", "archived-approval", "pending"));
      const values = yield* Queue.unbounded<DecisionFeedValue>();
      const feed = yield* Feed.DecisionFeed;
      yield* feed.stream(client).pipe(
        Stream.runForEach((value) => Queue.offer(values, value)),
        Effect.forkScoped,
      );

      // An archived thread's approval has nowhere to go, as with its other decisions.
      expect((yield* Queue.take(values)).handoffs).toEqual([]);

      const pending = approvalItem("asking", "approval", "pending");
      yield* writeItem(pending);
      yield* Queue.offer(events, handoffEvent(pending, 1));
      const listed = yield* Queue.take(values);
      expect(listed.handoffs?.map((entry) => entry.handoff.handoffId)).toEqual(["approval"]);
      expect(listed.handoffs?.[0]?.threadTitle).toBe("Asking thread");

      const answered = approvalItem("asking", "approval", "completed");
      yield* writeItem(answered);
      yield* Queue.offer(events, handoffEvent(answered, 2));
      expect((yield* Queue.take(values)).handoffs).toEqual([]);
    }).pipe(
      Effect.provide(Feed.layer.pipe(Layer.provideMerge(fixture()), Layer.provide(sinkLayer))),
    );
  }).pipe(Effect.scoped),
);

it.effect(
  "the feed sends the newest open approvals up to its limit and says how many are open",
  () =>
    Effect.gen(function* () {
      yield* seedThread("asking");
      for (let index = 0; index <= MAX_FEED_HANDOFFS; index += 1)
        yield* writeItem(
          approvalItem(
            "asking",
            "approval-" + String(index).padStart(4, "0"),
            "pending",
            DateTime.add(defaultCreatedAt, { seconds: index }),
          ),
        );
      const result = yield* openApprovalHandoffs();
      expect(result.handoffs).toHaveLength(MAX_FEED_HANDOFFS);
      expect(result.total).toBe(MAX_FEED_HANDOFFS + 1);
      expect(result.handoffs[0]?.handoff.handoffId).toBe("approval-0001");
    }).pipe(Effect.provide(fixture())),
);
