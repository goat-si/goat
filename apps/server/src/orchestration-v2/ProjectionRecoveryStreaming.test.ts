import { assert, it } from "@effect/vitest";
import { EventId, MessageId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { createThread, createRun } from "./ProjectionRecovery.testkit.ts";
const layerTest = Layer.mergeAll(ProjectionStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
it.effect("bounds streaming recovery reads by candidate runs and preserves message ordering", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("streaming");
    const other = yield* createThread("streaming-other");
    const empty = yield* createThread("streaming-empty");
    const statements: Array<ReturnType<Statement.Statement<unknown>["compile"]>> = [];
    let reads = 0;
    const observe: Statement.Transformer = (statement) => {
      const compiled = statement.compile();
      if (/^\s*SELECT/i.test(compiled[0])) reads++;
      if (compiled[0].includes("SELECT message.payload_json")) statements.push(compiled);
      return Effect.succeed(statement);
    };
    const expected: MessageId[] = [];
    const statuses = [
      "queued",
      "preparing",
      "starting",
      "running",
      "waiting",
      "completed",
      "interrupted",
      "rolled_back",
      "failed",
      "cancelled",
    ] as const;
    for (const [index, status] of statuses.entries()) {
      const runId = yield* createRun(threadId, status, { ordinal: index + 1 });
      for (const suffix of ["b", "a", "settled", "wrong-thread"]) {
        const id = MessageId.make(`message:streaming:${index}:${suffix}`);
        const streaming = suffix !== "settled";
        const messageThread = suffix === "wrong-thread" ? other : threadId;
        const createdAt = DateTime.add(now, { seconds: -index });
        yield* projections.apply({
          id: EventId.make(`event:${id}`),
          type: "message.updated",
          threadId: messageThread,
          runId,
          occurredAt: now,
          payload: {
            id,
            threadId: messageThread,
            runId,
            nodeId: null,
            role: "assistant",
            text: id,
            attachments: [],
            streaming,
            createdAt,
            updatedAt: now,
            createdBy: "agent",
            creationSource: "provider",
          },
        });
      }
      if (index < 5)
        expected.unshift(
          MessageId.make(`message:streaming:${index}:a`),
          MessageId.make(`message:streaming:${index}:b`),
        );
    }
    const foreignRun = yield* createRun(other, "running");
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('foreign-run', ${threadId}, ${foreignRun}, 'assistant', 1, '', '', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('old-history', ${empty}, NULL, 'assistant', 1, '', '', '{}')
    `;
    const projection = yield* projections
      .getRuntimeRecoveryProjection(threadId)
      .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
    assert.deepEqual(
      projection.messages.map((message) => message.id),
      expected,
    );
    const emptyProjection = yield* projections
      .getRuntimeRecoveryProjection(empty)
      .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
    assert.deepEqual(emptyProjection.messages, []);
    assert.equal(reads, 4);
    assert.equal(statements.length, 2);
    for (const [query, params] of statements) {
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params);
      assert.isTrue(
        plan.some((row) => row.detail.includes("SEARCH message_run ")),
        JSON.stringify(plan),
      );
      assert.isTrue(
        plan.some((row) => row.detail.includes("messages_run_idx")),
        JSON.stringify(plan),
      );
      assert.isFalse(
        plan.some((row) => /\bSCAN message\b/.test(row.detail)),
        JSON.stringify(plan),
      );
      assert.isFalse(
        plan.some((row) => row.detail.includes("messages_thread_created_idx")),
        JSON.stringify(plan),
      );
    }
  }).pipe(Effect.provide(layerTest)),
);
