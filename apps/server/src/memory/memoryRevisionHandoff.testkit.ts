import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Fixture from "../mcp/toolkits/memory/handlers.testkit.ts";
import receiptsMigration from "../persistence/Migrations/185_TurnMemoryReceipts.ts";
import { caller, environmentId, live, save, setupThreads } from "./MemoryRecall.testkit.ts";
import { MemoryRecall } from "./MemoryRecall.ts";
import { MemoryService } from "./MemoryService.ts";
import { MemoryStore } from "./MemoryStore.ts";

/** Capture independent reads by B on either side of indexing A's edit. No background indexer. */
export const revisionHandoff = (oldCode: string, currentCode: string) =>
  Effect.gen(function* () {
    yield* setupThreads;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_v2_events(thread_id TEXT, event_type TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT, run_id TEXT, type TEXT, payload_json TEXT, ordinal INTEGER DEFAULT 1)`;
    yield* receiptsMigration;
    const recall = yield* MemoryRecall;
    const service = yield* MemoryService;
    const store = yield* MemoryStore;
    const memoryId = M.MemoryId.make(Fixture.id(11));
    const scope = {
      kind: "thread" as const,
      thread: { environmentId, threadId: M.ThreadId.make("other") },
    };
    const query = "release acceptance code";
    const read = (phase: string) =>
      Effect.gen(function* () {
        const runId = M.RunId.make(phase);
        const result = yield* recall.recall({ query }, Effect.void, caller, runId);
        const receipt = yield* service.inspectTurn(
          { memorySpaceId: Fixture.space, threadId: caller.threadId, runId },
          Effect.void,
        );
        return { runId, result, receipt };
      });
    const oldRevision = yield* save(11, scope, query + ": " + oldCode);
    const initial = yield* read("prior");
    yield* service.upsert(
      {
        ...Fixture.upsert(889),
        memoryId,
        scope,
        expectedHeads: [oldRevision],
        payload: { text: query + ": " + currentCode, evidence: [], derivedFromMemoryRevisions: [] },
      },
      Effect.void,
    );
    const head = yield* store.loadAggregate(Fixture.space, memoryId);
    if (head.item?.status !== "active") throw new Error("Edited fixture has no active head");
    const currentRevision = head.item.revision.revisionId;
    const pending = yield* read("pending");
    yield* store.index({
      memorySpaceId: Fixture.space,
      memoryId,
      revisionId: currentRevision,
      generation: head.generation,
    });
    const indexed = yield* read("indexed");
    return { memoryId, oldRevision, currentRevision, initial, pending, indexed };
  }).pipe(Effect.provide(live));
