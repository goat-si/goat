import { CommandId, ThreadId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import { SkipThreadArchiveRestore } from "./ThreadArchiveGate.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadHistoryArchive from "./ThreadHistoryArchive.ts";

/**
 * Records each archive state on its thread, so every client's thread list can say that the
 * history is archived. Restores happen inside reads, so the command is sent from here, never
 * from the read itself.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const archive = yield* ThreadHistoryArchive.ThreadHistoryArchive;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sql = yield* SqlClient.SqlClient;

    const record = Effect.fn("ThreadHistoryArchiveLabels.record")(function* (
      change: ThreadHistoryArchive.ThreadHistoryArchiveChange,
    ) {
      const at = yield* Clock.currentTimeMillis;
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(
            `history-archive:${change.threadId}:${change.state ?? "restored"}:${at}`,
          ),
          threadId: ThreadId.make(change.threadId),
          historyArchive: change.state,
        })
        .pipe(
          Effect.provideService(SkipThreadArchiveRestore, true),
          Effect.catchCause((cause) =>
            Effect.logWarning("Recording a thread's history archive state failed", {
              threadId: change.threadId,
              cause,
            }),
          ),
        );
    });

    // A crash between an archive change and its command leaves the thread saying the wrong
    // thing; compare the index with what threads say once at startup.
    const reconcile = Effect.gen(function* () {
      const drift = yield* sql<{ readonly thread_id: string; readonly state: string | null }>`
        SELECT archive.thread_id, archive.state FROM orchestration_v2_thread_history_archives AS archive
        JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = archive.thread_id
        WHERE coalesce(json_extract(thread.payload_json, '$.historyArchive'), '')
          != CASE archive.state WHEN 'restoring' THEN 'archived' ELSE archive.state END
        UNION ALL
        SELECT thread.thread_id, NULL FROM orchestration_v2_projection_threads AS thread
        WHERE json_extract(thread.payload_json, '$.historyArchive') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_thread_history_archives AS archive
            WHERE archive.thread_id = thread.thread_id
          )
      `;
      for (const row of drift)
        yield* record({
          threadId: row.thread_id,
          state: row.state === "deleted" ? "deleted" : row.state === null ? null : "archived",
        });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Reconciling thread history archive states failed", { cause }),
      ),
    );

    yield* forkParked(archive.changes.pipe(Stream.runForEach(record)));
    yield* forkParked(reconcile);
  }),
);
