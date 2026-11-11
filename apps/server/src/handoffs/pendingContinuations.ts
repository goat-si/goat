import { Handoff, type HandoffError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { unavailable } from "./handoffDecode.ts";
import type { PrivatePayload } from "./handoffPrivatePayload.ts";

const decodeHandoff = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(Handoff)),
);

/** Pending handoffs on one target path with their continuation arguments, across threads. */
export const makePendingContinuations =
  (
    sql: SqlClient.SqlClient,
    loadPrivate: (id: string) => Effect.Effect<PrivatePayload | null, HandoffError>,
  ) =>
  (path: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly handoff_json: string | null }>`
        SELECT json_extract(payload_json, '$.handoff') AS handoff_json
        FROM orchestration_v2_projection_turn_items
        WHERE type IN ('human_handoff', 'secret_request') AND status = 'waiting'
          AND json_extract(payload_json, '$.handoff.target.path') = ${path}`.pipe(
        Effect.mapError(unavailable),
      );
      const results: Array<{ handoff: Handoff; args: Readonly<Record<string, unknown>> }> = [];
      for (const row of rows) {
        if (row.handoff_json === null) continue;
        const handoff = yield* decodeHandoff(row.handoff_json).pipe(Effect.mapError(unavailable));
        const payload = yield* loadPrivate(handoff.handoffId);
        if (payload?.kind === "continuation") results.push({ handoff, args: payload.args });
      }
      return results;
    });
