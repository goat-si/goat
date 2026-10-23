import { ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class RemoteReportInboxError extends Schema.TaggedError<RemoteReportInboxError>()(
  "RemoteReportInboxError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Remote report inbox operation failed.";
  }
}
const Entry = Schema.Struct({
  id: Schema.Number,
  kind: Schema.String,
  text: Schema.String,
  host: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
});

/** A pending report and the launched thread it came from, when the inbox knows it. */
export interface PendingReport {
  readonly kind: string;
  readonly text: string;
  readonly host: string | null;
  readonly threadId: string | null;
  /** The run the report was sent from; null for older rows and reports without a run. */
  readonly runId: string | null;
}
const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(Entry));

export class RemoteReportInbox extends Context.Service<
  RemoteReportInbox,
  {
    readonly pending: (threadId: ThreadId) => Effect.Effect<
      {
        readonly texts: ReadonlyArray<string>;
        readonly reports: ReadonlyArray<PendingReport>;
        readonly throughId: number | null;
      },
      RemoteReportInboxError
    >;
    readonly consume: (
      threadId: ThreadId,
      throughId: number,
    ) => Effect.Effect<void, RemoteReportInboxError>;
  }
>()("goat/remoteReports/RemoteReportInbox") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pending = Effect.fn("RemoteReportInbox.pending")(function* (threadId: ThreadId) {
    // A local launch reports under local:<threadId>; a remote one under its dispatch.
    const rows = yield* sql`SELECT i.id, i.kind, i.text, d.host AS host, i.run_id AS "runId",
        COALESCE(d.remote_thread_id, CASE WHEN i.correlation_id LIKE 'local:%'
          THEN substr(i.correlation_id, 7) END) AS "threadId"
      FROM remote_report_inbox i LEFT JOIN remote_dispatches d ON d.correlation_id = i.correlation_id
      WHERE i.origin_thread_id = ${threadId} ORDER BY i.id LIMIT 20`.pipe(
      Effect.flatMap(decodeEntries),
      Effect.mapError((cause) => new RemoteReportInboxError({ cause })),
    );
    const texts: string[] = [];
    const reports: PendingReport[] = [];
    let throughId: number | null = null;
    let characters = 0;
    for (const row of rows) {
      // The cap includes the separators added by framePendingReports.
      const size = row.text.length + (texts.length === 0 ? 0 : 2);
      if (characters + size > 16_000) break;
      texts.push(row.text);
      reports.push({
        kind: row.kind,
        text: row.text,
        host: row.host,
        threadId: row.threadId,
        runId: row.runId,
      });
      throughId = row.id;
      characters += size;
    }
    return { texts, reports, throughId };
  });
  const consume = Effect.fn("RemoteReportInbox.consume")(function* (
    threadId: ThreadId,
    throughId: number,
  ) {
    yield* sql`DELETE FROM remote_report_inbox
      WHERE origin_thread_id = ${threadId} AND id <= ${throughId}`.pipe(
      Effect.mapError((cause) => new RemoteReportInboxError({ cause })),
    );
  });
  return RemoteReportInbox.of({ pending, consume });
});
export const layer = Layer.effect(RemoteReportInbox, make);
export const layerEmpty = Layer.succeed(
  RemoteReportInbox,
  RemoteReportInbox.of({
    pending: () => Effect.succeed({ texts: [], reports: [], throughId: null }),
    consume: () => Effect.void,
  }),
);
