import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { stored } from "./store/StoreCodecs.ts";

const encodeRevisions = Schema.encodeSync(Schema.fromJsonString(Schema.Array(M.MemoryRevisionId)));

export const areAutomaticallyUsable = Effect.fn("MemoryService.areAutomaticallyUsable")(function* (
  space: M.MemorySpaceId,
  revisions: readonly M.MemoryRevisionId[],
) {
  if (revisions.length === 0) return true;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* stored(
    "memory-provenance-read",
    sql`SELECT 1 FROM memory_revision_marks WHERE space=${space}
      AND revision_id IN (SELECT value FROM json_each(${encodeRevisions(revisions)})) LIMIT 1`,
  );
  return rows.length === 0;
});

const markUnverified = Effect.fn("MemoryService.markUnverified")(function* (
  space: M.MemorySpaceId,
  revisionId: M.MemoryRevisionId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* stored(
    "memory-provenance-write",
    sql`INSERT INTO memory_revision_marks(space,revision_id,provenance)
      VALUES (${space},${revisionId},'unverified') ON CONFLICT(space,revision_id) DO NOTHING`,
  );
});

export const recordMemoryOrigin = Effect.fn("MemoryService.recordMemoryOrigin")(function* (
  space: M.MemorySpaceId,
  memoryId: M.MemoryId,
  origin: M.ScopedThreadRef,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* stored(
    "memory-origin-write",
    sql`INSERT INTO memory_origins(space,memory_id,environment_id,thread_id)
      VALUES (${space},${memoryId},${origin.environmentId},${origin.threadId})
      ON CONFLICT(space,memory_id) DO NOTHING`,
  );
});

export const readMemoryOrigin = Effect.fn("MemoryService.readMemoryOrigin")(function* (
  space: M.MemorySpaceId,
  memoryId: M.MemoryId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* stored(
    "memory-origin-read",
    sql<{ environment_id: string; thread_id: string }>`
      SELECT environment_id,thread_id FROM memory_origins WHERE space=${space} AND memory_id=${memoryId}`,
  );
  return row
    ? {
        environmentId: M.EnvironmentId.make(row.environment_id),
        threadId: M.ThreadId.make(row.thread_id),
      }
    : undefined;
});

export const persistRevisionMarks = Effect.fn("MemoryStore.persistRevisionMarks")(function* (
  revision: M.MemoryRevision,
) {
  const { memorySpaceId, memoryId, revisionId, provenance } = revision;
  if (provenance.unverified) yield* markUnverified(memorySpaceId, revisionId);
  if (provenance.originThreadId) {
    const origin = { environmentId: provenance.environmentId, threadId: provenance.originThreadId };
    yield* recordMemoryOrigin(memorySpaceId, memoryId, origin);
    const sql = yield* SqlClient.SqlClient;
    yield* stored(
      "memory-checkpoint-origin",
      sql`UPDATE memory_identity_ledger
      SET identity_json=json_set(identity_json,'$.origin',json_object(
        'environmentId',${origin.environmentId},'threadId',${origin.threadId}))
      WHERE space=${memorySpaceId} AND memory_id=${memoryId}
      AND json_extract(identity_json,'$.creatingEnvironmentId')=${origin.environmentId}
      AND json_type(identity_json,'$.origin') IS NULL`,
    );
  }
});
