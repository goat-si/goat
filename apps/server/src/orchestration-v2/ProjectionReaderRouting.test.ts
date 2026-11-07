import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { layerReaderDatabase, traceSqlRouting } from "../persistence/testkit/SqliteRouting.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { createThread, createRun } from "./ProjectionRecovery.testkit.ts";
it.effect("routes full projection reads to readers and retains uncommitted writer state", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const parentId = yield* createThread("reader-routing");
    const parentRun = yield* createRun(parentId, "completed");
    const now = yield* DateTime.now;
    yield* store.apply({
      id: EventId.make("event:reader-routing:item"),
      type: "turn-item.updated",
      threadId: parentId,
      runId: parentRun,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:reader-routing"),
        threadId: parentId,
        runId: parentRun,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: "Original",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "command_execution",
        input: "echo fixture",
      },
    });
    const parent = yield* store.getThreadProjection(parentId);
    const threadId = ThreadId.make("thread:reader-routing:fork");
    yield* store.apply({
      id: EventId.make("event:reader-routing:fork"),
      type: "thread.created",
      threadId,
      occurredAt: parent.thread.createdAt,
      payload: {
        ...parent.thread,
        id: threadId,
        forkedFrom: { type: "run", threadId: parentId, runId: parent.runs[0]!.id },
      },
    });
    const { queries, trace } = traceSqlRouting();
    const projection = yield* store.getThreadProjection(threadId).pipe(trace);
    assert.equal(projection.thread.id, threadId);
    assert.deepEqual(
      projection.visibleTurnItems
        .filter((row) => row.visibility === "inherited")
        .map((row) => row.sourceItemId),
      parent.turnItems.map((item) => item.id),
    );
    assert.isAbove(queries.length, 1);
    assert.deepEqual([...new Set(queries.map((row) => row.connection))], ["reader"]);
    const commitRequested = yield* Deferred.make<void>();
    const writer = yield* Deferred.await(commitRequested).pipe(
      Effect.andThen(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, '$.title', 'Committed title')
          WHERE thread_id = ${threadId}
        `;
            yield* sql`
          UPDATE orchestration_v2_projection_turn_items
          SET payload_json = json_set(payload_json, '$.title', 'Committed command')
          WHERE thread_id = ${parentId}
        `;
          }),
        ),
      ),
      Effect.forkChild,
    );
    let commitInjected = false;
    const duringCommit = yield* store.getThreadProjection(threadId).pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) => {
        const [query] = statement.compile();
        if (!commitInjected && query.includes("FROM orchestration_v2_projection_turn_items")) {
          commitInjected = true;
          return Deferred.succeed(commitRequested, undefined).pipe(
            Effect.andThen(Fiber.join(writer).pipe(Effect.orDie)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      }),
    );
    assert.isTrue(commitInjected);
    assert.deepEqual(duringCommit, projection);
    const afterCommit = yield* store.getThreadProjection(threadId);
    assert.equal(afterCommit.thread.title, "Committed title");
    assert.equal(
      afterCommit.visibleTurnItems.find((row) => row.visibility === "inherited")?.item.title,
      "Committed command",
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.title', 'Uncommitted title')
        WHERE thread_id = ${threadId}
      `;
        assert.equal(
          (yield* store.getThreadProjection(threadId)).thread.title,
          "Uncommitted title",
        );
      }),
    );
  }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(layerReaderDatabase)))),
);
