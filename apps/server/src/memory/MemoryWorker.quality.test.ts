import { assert, describe, it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as M from "@goat/contracts";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Worker from "./MemoryWorker.ts";
import {
  id,
  environmentId,
  space,
  threadId,
  now,
  live,
  seed,
  seedDerivedSummary,
  incrementalSummary,
} from "./MemoryWorker.testkit.ts";

describe("MemoryWorker summary quality", () => {
  it.effect("forgets a summary whose consolidation reread the same run", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const store = yield* Store.MemoryStore;
      const service = yield* Service.MemoryService;
      const worker = yield* Worker.MemoryWorker;
      yield* worker.sweepDue();
      yield* TestClock.adjust(86400000 + Worker.MEMORY_CONTINUATION_SCAN_INTERVAL_MS);
      yield* worker.sweepDue();
      const summaryId = M.MemoryId.make(
        Service.memoryStableUuid(`${environmentId}:${threadId}:summary`),
      );
      const before = yield* store.loadAggregate(space, summaryId);
      // Both revisions cite the same run, so their source exclusions are identical.
      assert.strictEqual(before.revisions.length, 2);
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId: summaryId,
          operationId: M.MemoryOperationId.make(id(9400)),
          expectedHeads: before.heads,
        },
        Effect.void,
      );
      assert.isDefined((yield* store.loadAggregate(space, summaryId)).tombstone);
    }).pipe(Effect.provide(live())),
  );
  it.effect(
    "consolidation promotes durable facts that other threads find and forget follows",
    () => {
      const cited = (input: M.GenerateMemorySummaryInput, text: string) => ({
        text,
        assertionKind: "fact" as const,
        evidence: [
          {
            origin: "thread" as const,
            sourceThread: input.sourceThread,
            watermark: input.sourceWatermark,
            messageIds: input.messages.map((message) => message.messageId),
          },
        ],
      });
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now));
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Store.MemoryStore;
        const service = yield* Service.MemoryService;
        const worker = yield* Worker.MemoryWorker;
        yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN project_id TEXT`;
        yield* sql`UPDATE orchestration_v2_projection_threads SET project_id='project'`;
        yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
        yield* sql`INSERT INTO projection_projects VALUES ('project','/synthetic/project',NULL)`;
        const projectKey = { kind: "explicit" as const, sharedProjectId: "shared" };
        yield* store.putProjectBinding(
          {
            memorySpaceId: space,
            project: { environmentId, projectId: M.ProjectId.make("project") },
            projectKey,
            repositoryKey: null,
            version: 0,
          },
          null,
          Date.parse(now),
        );
        yield* worker.sweepDue();
        const scoped = (scope: M.MemoryScope) =>
          store.list({ memorySpaceId: space, scope, limit: 20 });
        // Ordinary per-run summaries never promote.
        assert.deepStrictEqual(yield* scoped({ kind: "user" }), []);
        yield* TestClock.adjust(86400000 + Worker.MEMORY_CONTINUATION_SCAN_INTERVAL_MS);
        yield* worker.sweepDue();
        const project = yield* scoped({ kind: "project", projectKey });
        const user = yield* scoped({ kind: "user" });
        assert.deepStrictEqual(
          [...project, ...user].map((item) => item.status),
          ["active", "active"],
        );
        const summaryId = M.MemoryId.make(
          Service.memoryStableUuid(`${environmentId}:${threadId}:summary`),
        );
        yield* service.forget(
          {
            memorySpaceId: space,
            memoryId: summaryId,
            operationId: M.MemoryOperationId.make(id(9300)),
            expectedHeads: (yield* store.loadAggregate(space, summaryId)).heads,
          },
          Effect.void,
        );
        assert.notInclude(
          [
            ...(yield* scoped({ kind: "project", projectKey })),
            ...(yield* scoped({ kind: "user" })),
          ].map((item) => item.status),
          "active",
        );
      }).pipe(
        Effect.provide(
          live(false, undefined, false, 0, false, undefined, (input) => ({
            project: cited(input, "Synthetic project decision"),
            user: cited(input, "Synthetic user preference"),
          })),
        ),
      );
    },
  );
  it.effect("never summarizes or consolidates a delegated child thread", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_events VALUES (0,${id(9)},${threadId},'thread.created','{"creationSource":"mcp","lineage":{"relationshipToParent":"subagent"}}',${now},2,'thread')`;
      const worker = yield* Worker.MemoryWorker;
      const store = yield* Store.MemoryStore;
      yield* worker.sweepDue();
      // A later recovery scan, past the consolidation age, must not pick the thread up either.
      yield* TestClock.adjust(86400000 + Worker.MEMORY_CONTINUATION_SCAN_INTERVAL_MS);
      yield* worker.sweepDue();
      yield* worker.drain;
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_outbox WHERE kind IN ('summary','consolidate') AND status!='cancelled'`)[0]!
          .count,
        0,
      );
      assert.deepStrictEqual(
        yield* store.list({
          memorySpaceId: space,
          scope: { kind: "thread", thread: { environmentId, threadId } },
          limit: 20,
        }),
        [],
      );
    }).pipe(Effect.provide(live())),
  );
  it.effect(
    "keeps one failure report per summary work and drops it once the memory is generated",
    () => {
      let calls = 0;
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now));
        yield* seed;
        const worker = yield* Worker.MemoryWorker;
        const store = yield* Store.MemoryStore;
        yield* worker.sweepDue();
        assert.strictEqual((yield* store.pendingReports(100)).length, 1);
        yield* TestClock.adjust(Worker.memoryRetryDelay(1));
        yield* worker.sweepDue();
        assert.strictEqual(calls, 2);
        // Retries of the same work replace its report instead of adding one per attempt.
        assert.strictEqual((yield* store.pendingReports(100)).length, 1);
        yield* TestClock.adjust(Worker.memoryRetryDelay(2));
        yield* worker.sweepDue();
        assert.strictEqual(calls, 3);
        assert.deepStrictEqual(yield* store.pendingReports(100), []);
      }).pipe(Effect.provide(live(() => (++calls < 3 ? "synthetic failure" : undefined))));
    },
  );
  it.effect("a summary with nothing durable writes no memory and settles its range", () =>
    Effect.gen(function* () {
      yield* seed;
      const worker = yield* Worker.MemoryWorker;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* worker.sweepDue();
      assert.deepStrictEqual(
        yield* store.list({
          memorySpaceId: space,
          scope: { kind: "thread", thread: { environmentId, threadId } },
          limit: 20,
        }),
        [],
      );
      assert.deepStrictEqual(
        (yield* sql<{
          status: string;
        }>`SELECT status FROM memory_outbox WHERE kind='summary'`).map((row) => row.status),
        ["completed"],
      );
      assert.deepStrictEqual(yield* store.pendingReports(100), []);
    }).pipe(Effect.provide(live(false, undefined, false, 0, false, () => true))),
  );
  it.effect("an empty later chunk keeps the useful chunk before it", () =>
    Effect.gen(function* () {
      const { target, d0 } = yield* seedDerivedSummary;
      const after = yield* incrementalSummary(target);
      assert.notStrictEqual(after.heads[0], d0);
      const head = after.revisions.find((pair) => pair.revision.revisionId === after.heads[0]);
      assert.include(head?.payload?.text, "increment-102");
      assert.notInclude(head?.payload?.text, "increment-103");
    }).pipe(
      Effect.provide(
        live(false, undefined, false, 0, false, (input) =>
          input.messages.some((message) => message.messageId === "increment-103"),
        ),
      ),
    ),
  );
});
