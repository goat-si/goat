import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { decodeThreadPayload } from "./ProjectionThreadPayload.ts";
import {
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
  type ProjectionStoreV2Shape,
} from "./ProjectionStore.ts";

export function makeProjectionThreadReads(sql: SqlClient.SqlClient) {
  const findThread: ProjectionStoreV2Shape["findThread"] = Effect.fn("ProjectionStore.findThread")(
    function* (threadId) {
      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      return rows[0] === undefined ? null : yield* decodeThreadPayload(rows[0].payload_json);
    },
    (effect, threadId) =>
      effect.pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause }))),
  );
  const getThread: ProjectionStoreV2Shape["getThread"] = Effect.fn("ProjectionStore.getThread")(
    function* (threadId) {
      const thread = yield* findThread(threadId);
      return thread ?? (yield* new ProjectionStoreThreadNotFoundError({ threadId }));
    },
  );
  return { findThread, getThread };
}
