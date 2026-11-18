import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { MemoryStorageError } from "../../memory/store/StoreModel.ts";

const decodeLegacyLineage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.Literal("threadLineage"),
      sourceThread: M.ScopedThreadRef,
      memorySpaceId: M.MemorySpaceId,
      state: Schema.Literals(["tracked", "unknown", "overflow"]),
      revisions: Schema.Array(M.MemoryRevisionId).check(Schema.isMaxLength(100)),
    }),
  ),
);

const encodeThread = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([M.EnvironmentId, M.ThreadId])),
);
const encodeRevisions = Schema.encodeSync(Schema.fromJsonString(Schema.Array(M.MemoryRevisionId)));
const malformedLineage = new MemoryStorageError({
  stage: "legacy-thread-lineage",
  cause: undefined,
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE memory_thread_lineages (
    environment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    space TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('tracked','unknown','overflow')),
    count INTEGER NOT NULL CHECK(count BETWEEN 0 AND 1000),
    PRIMARY KEY(environment_id,thread_id)
  )`;
  yield* sql`CREATE TABLE memory_thread_lineage_revisions (
    environment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    revision_id TEXT NOT NULL,
    PRIMARY KEY(environment_id,thread_id,ordinal),
    UNIQUE(environment_id,thread_id,revision_id),
    FOREIGN KEY(environment_id,thread_id)
      REFERENCES memory_thread_lineages(environment_id,thread_id) ON DELETE CASCADE
  )`;
  yield* sql`CREATE INDEX memory_thread_lineage_revision_idx
    ON memory_thread_lineage_revisions(revision_id)`;
  yield* sql`CREATE TABLE memory_revision_marks (
    space TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK(provenance='unverified'),
    PRIMARY KEY(space,revision_id)
  )`;
  yield* sql`CREATE TABLE memory_origins (
    space TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    PRIMARY KEY(space,memory_id)
  )`;
  yield* sql`CREATE INDEX memory_origins_thread_idx
    ON memory_origins(space,environment_id,thread_id,memory_id)`;
  yield* sql`CREATE TABLE memory_space_features (
    space TEXT PRIMARY KEY NOT NULL,
    derived_cap INTEGER NOT NULL,
    activated_at INTEGER NOT NULL
  )`;
  let cursor: string | null = null;
  while (true) {
    const rows: ReadonlyArray<{ id: string; metadata_json: string }> = yield* sql<{
      id: string;
      metadata_json: string;
    }>`SELECT id,metadata_json FROM memory_outbox
      WHERE (${cursor} IS NULL OR id>${cursor}) AND
        (id GLOB 'memory:thread-lineage:*' OR
          CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.kind')='threadLineage' END)
      ORDER BY id LIMIT 100`;
    if (rows.length === 0) break;
    for (const row of rows) {
      const { sourceThread, memorySpaceId, state, revisions } = yield* decodeLegacyLineage(
        row.metadata_json,
        { onExcessProperty: "error" },
      ).pipe(Effect.mapError(() => malformedLineage));
      const { environmentId, threadId } = sourceThread;
      if (
        row.id !== `memory:thread-lineage:${encodeThread([environmentId, threadId])}` ||
        new Set(revisions).size !== revisions.length
      )
        return yield* malformedLineage;
      yield* sql`INSERT INTO memory_thread_lineages (environment_id,thread_id,space,state,count)
        VALUES (${environmentId},${threadId},${memorySpaceId},${state},${revisions.length})`;
      if (revisions.length)
        yield* sql`INSERT INTO memory_thread_lineage_revisions
          (environment_id,thread_id,ordinal,revision_id)
          SELECT ${environmentId},${threadId},key,value FROM json_each(${encodeRevisions(revisions)})`;
      yield* sql`DELETE FROM memory_outbox WHERE id=${row.id}`;
      cursor = row.id;
    }
  }
});
