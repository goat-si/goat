import { assert, describe, it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as M from "@goat/contracts";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Worker from "./MemoryWorker.ts";
import { MEMORY_GENERATION_REPORTS_MAX } from "./store/Reports.ts";
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
  seedRolledBackRegeneration,
} from "./MemoryWorker.testkit.ts";
import { redactGoatCredentials } from "../mcp/goatCredentialRedaction.ts";

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
const userPromotionId = M.MemoryId.make(
  Service.memoryStableUuid(`${environmentId}:${threadId}:promotion:user`),
);
// Summarize the seeded run, then let its daily consolidation run.
const summarizeThenConsolidate = (
  beforeConsolidation: Effect.Effect<
    void,
    never,
    Service.MemoryService | Store.MemoryStore
  > = Effect.void,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now));
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN project_id TEXT`;
    const worker = yield* Worker.MemoryWorker;
    yield* worker.sweepDue();
    yield* beforeConsolidation;
    yield* TestClock.adjust(86400000 + Worker.MEMORY_CONTINUATION_SCAN_INTERVAL_MS);
    yield* worker.sweepDue();
  });
const headText = (memoryId: M.MemoryId) =>
  Effect.gen(function* () {
    const aggregate = yield* (yield* Store.MemoryStore).loadAggregate(space, memoryId);
    return aggregate.revisions.find((pair) => pair.revision.revisionId === aggregate.heads[0])
      ?.payload?.text;
  });

describe("MemoryWorker summary quality", () => {
  it.effect(
    "a promotion from an empty consolidation follows memories injected after its summary",
    () =>
      Effect.gen(function* () {
        const injected = M.MemoryId.make(id(9700));
        const inject = Effect.gen(function* () {
          const service = yield* Service.MemoryService;
          const store = yield* Store.MemoryStore;
          yield* service.upsert(
            {
              memorySpaceId: space,
              memoryId: injected,
              operationId: M.MemoryOperationId.make(id(9701)),
              expectedHeads: [],
              scope: { kind: "user" },
              assertionKind: "inference",
              payload: {
                text: "synthetic injected source",
                evidence: [],
                derivedFromMemoryRevisions: [],
              },
              baseBoundary: null,
            },
            Effect.void,
          );
          const revision = (yield* store.loadAggregate(space, injected)).heads;
          yield* store.appendThreadLineage({ environmentId, threadId }, space, revision);
        }).pipe(Effect.orDie);
        yield* summarizeThenConsolidate(inject);
        const store = yield* Store.MemoryStore;
        assert.strictEqual(yield* headText(userPromotionId), "Synthetic user preference");
        yield* (yield* Service.MemoryService).forget(
          {
            memorySpaceId: space,
            memoryId: injected,
            operationId: M.MemoryOperationId.make(id(9702)),
            expectedHeads: (yield* store.loadAggregate(space, injected)).heads,
          },
          Effect.void,
        );
        const page = yield* store.list({
          memorySpaceId: space,
          scope: { kind: "user" },
          limit: 20,
        });
        assert.notStrictEqual(
          page.find((item) => item.memoryId === userPromotionId)?.status,
          "active",
        );
      }).pipe(
        Effect.provide(
          live(
            false,
            undefined,
            false,
            0,
            false,
            (input) => input.promote === true,
            (input) => ({ project: null, user: cited(input, "Synthetic user preference") }),
          ),
        ),
      ),
  );
  it.effect("forgets a summary that cites more than 100 messages of one run", () =>
    Effect.gen(function* () {
      yield* seedRolledBackRegeneration;
      const worker = yield* Worker.MemoryWorker;
      yield* worker.sweepDue();
      yield* worker.sweepDue();
      yield* worker.drain;
      const store = yield* Store.MemoryStore;
      const summaryId = M.MemoryId.make(
        Service.memoryStableUuid(`${environmentId}:${threadId}:summary`),
      );
      const before = yield* store.loadAggregate(space, summaryId);
      yield* (yield* Service.MemoryService).forget(
        {
          memorySpaceId: space,
          memoryId: summaryId,
          operationId: M.MemoryOperationId.make(id(9600)),
          expectedHeads: before.heads,
        },
        Effect.void,
      );
      assert.isDefined((yield* store.loadAggregate(space, summaryId)).tombstone);
    }).pipe(Effect.provide(live())),
  );
  it.effect("promoted text never keeps a GOAT credential", () => {
    const raw = `Use curl -H 'Authorization: Bearer ${"f".repeat(51)}' for the synthetic service.`;
    return Effect.gen(function* () {
      yield* summarizeThenConsolidate();
      const stored = yield* headText(userPromotionId);
      assert.strictEqual(stored, redactGoatCredentials(raw));
      assert.notStrictEqual(stored, raw);
    }).pipe(
      Effect.provide(
        live(false, undefined, false, 0, false, undefined, (input) => ({
          project: null,
          user: cited(input, raw),
        })),
      ),
    );
  });
  it.effect("consolidation never overwrites a person's own memory at the promotion id", () =>
    Effect.gen(function* () {
      const manual = Effect.gen(function* () {
        yield* (yield* Service.MemoryService).upsert(
          {
            memorySpaceId: space,
            memoryId: userPromotionId,
            operationId: M.MemoryOperationId.make(id(9500)),
            expectedHeads: [],
            scope: { kind: "user" },
            assertionKind: "inference",
            payload: { text: "written by hand", evidence: [], derivedFromMemoryRevisions: [] },
            baseBoundary: null,
          },
          Effect.void,
        );
      }).pipe(Effect.orDie);
      yield* summarizeThenConsolidate(manual);
      assert.strictEqual(yield* headText(userPromotionId), "written by hand");
    }).pipe(
      Effect.provide(
        live(false, undefined, false, 0, false, undefined, (input) => ({
          project: null,
          user: cited(input, "Synthetic user preference"),
        })),
      ),
    ),
  );
  it.effect("a consolidation with nothing new to summarize still promotes", () =>
    Effect.gen(function* () {
      yield* summarizeThenConsolidate();
      assert.strictEqual(yield* headText(userPromotionId), "Synthetic user preference");
    }).pipe(
      Effect.provide(
        live(
          false,
          undefined,
          false,
          0,
          false,
          (input) => input.promote === true,
          (input) => ({ project: null, user: cited(input, "Synthetic user preference") }),
        ),
      ),
    ),
  );
  it.effect("generation diagnostics keep one row per memory and never fill the report budget", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      for (let index = 0; index < 150; index++)
        yield* sql`INSERT INTO memory_report_outbox
          (report_id,space,memory_id,operation_id,resolution_id,attempt_id,resolving_environment_id,outcome,state,failure_code,created_at,report_kind,report_approved,attempts_known)
          VALUES (${`synthetic-${index}`},${space},${id(20000 + index)},${id(30000 + index)},NULL,${id(30000 + index)},${environmentId},'failed','pending','generation_failed',${index},'consolidate',1,1)`;
      yield* (yield* Worker.MemoryWorker).sweepDue();
      const rows = yield* sql<{
        memory_id: string;
      }>`SELECT memory_id FROM memory_report_outbox WHERE report_kind IN ('summary','consolidate') AND state!='delivered' ORDER BY created_at DESC`;
      assert.strictEqual(rows.length, MEMORY_GENERATION_REPORTS_MAX);
      assert.strictEqual(
        rows[0]?.memory_id,
        Service.memoryStableUuid(`${environmentId}:${threadId}:summary`),
      );
    }).pipe(Effect.provide(live(true))),
  );
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
