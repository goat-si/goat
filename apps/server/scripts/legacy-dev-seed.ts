import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class MigrateDevDbLegacySourceError extends Schema.TaggedError<MigrateDevDbLegacySourceError>()(
  "MigrateDevDbLegacySourceError",
  { sourcePath: Schema.String, legacyThreads: Schema.Number },
) {
  override get message(): string {
    return `Source database '${this.sourcePath}' contains ${this.legacyThreads} legacy threads not imported into V2. Start a server against an isolated copy first, then use the resulting statev2.sqlite as the source.`;
  }
}

export const rejectUnimportedLegacyThreads = Effect.fn("rejectUnimportedLegacyThreads")(function* (
  sourcePath: string,
  tables: ReadonlyArray<{ readonly name: string }>,
  hasV2: boolean,
) {
  if (!tables.some((table) => table.name === "projection_threads")) return;
  const sql = yield* SqlClient.SqlClient;
  const [pending] = hasV2
    ? yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM src.projection_threads AS thread
        WHERE NOT EXISTS (
          SELECT 1 FROM src.orchestration_events AS event INDEXED BY orchestration_events_v2_created_threads_idx
          WHERE event.application_event_version = 2 AND event.aggregate_kind = 'thread'
            AND event.stream_id = thread.thread_id AND event.event_type = 'thread.created')`
    : yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM src.projection_threads`;
  const legacyThreads = Number(pending?.count ?? 0);
  if (legacyThreads > 0)
    return yield* new MigrateDevDbLegacySourceError({ sourcePath, legacyThreads });
});
