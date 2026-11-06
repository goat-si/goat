import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

it.effect.each(["sqlite", "memory"] as const)(
  "selects only requested messages for the requested thread using $0 projections",
  (mode) => {
    const storeLayer =
      mode === "sqlite"
        ? ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))
        : ProjectionStore.layerMemory;
    return Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("lookup-thread");
      const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("lookup-project"),
        title: "Lookup",
        createdBy: "user",
        creationSource: "web",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* store.apply({
        id: EventId.make("lookup-thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      });
      const ids = [MessageId.make("lookup-one"), MessageId.make("lookup-two")];
      for (const id of ids)
        yield* store.apply({
          id: EventId.make(`event-${id}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id,
            threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: id,
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
          },
        });
      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") statements.push(query);
          };
          return span;
        },
      });
      const found = yield* store
        .getMessagesById(threadId, [ids[1]!, ids[0]!, ids[1]!, MessageId.make("absent")])
        .pipe(Effect.withTracer(tracer));
      assert.equal(found.size, 2);
      assert.equal(found.get(ids[0]!)?.text, ids[0]);
      assert.equal((yield* store.getMessagesById(threadId, [])).size, 0);
      assert.equal((yield* store.getMessagesById(ThreadId.make("other"), ids)).size, 0);
      if (mode === "sqlite") {
        assert.isTrue(statements.some((query) => query.includes("json_each")));
        assert.isFalse(statements.some((query) => query.includes("projection_turn_items")));
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.text', 'uncommitted') WHERE message_id = ${ids[0]}`;
            assert.equal(
              (yield* store.getMessagesById(threadId, [ids[0]!])).get(ids[0]!)?.text,
              "uncommitted",
            );
          }),
        );
      }
    }).pipe(Effect.provide(Layer.merge(storeLayer, SqlitePersistence.layerMemory)));
  },
);
