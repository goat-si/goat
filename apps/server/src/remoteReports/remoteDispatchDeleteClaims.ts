import type { ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { RemoteDispatchError } from "./remoteDispatchModel.ts";
import { decodeRemoteDispatchRows } from "./remoteDispatchRow.ts";

/** The origin-routed delete's claim on a finished thread dispatch, under that row's lock. */
export const makeDeleteClaims = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly withLock: <A, E, R>(
    id: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}) => {
  const { sql } = input;
  const db = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new RemoteDispatchError({ stage: "storage", cause })));
  const rows = <E>(statement: Effect.Effect<ReadonlyArray<unknown>, E>) =>
    db(statement.pipe(Effect.flatMap(decodeRemoteDispatchRows)));
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const claimDelete = Effect.fn("RemoteDispatchCoordinator.claimDelete")(function* (claim: {
    readonly originThreadId: ThreadId;
    readonly host: string;
    readonly remoteThreadId: string;
    readonly requestKey: string;
  }) {
    const found = yield* rows(sql`SELECT * FROM remote_dispatches
      WHERE kind = 'thread' AND origin_thread_id = ${claim.originThreadId}
        AND host = ${claim.host} AND remote_thread_id = ${claim.remoteThreadId}
      ORDER BY updated_at DESC LIMIT 1`);
    const first = found[0];
    if (first === undefined) return { _tag: "missing" as const };
    return yield* input.withLock(
      first.correlation_id,
      Effect.gen(function* () {
        const at = yield* now;
        const claimed = yield* db(sql<{ readonly read_key: string }>`UPDATE remote_dispatches
          SET delete_requested_at = ${at}, delete_request_key = ${claim.requestKey}, updated_at = ${at}
          WHERE correlation_id = ${first.correlation_id}
            AND state IN ('idle','settled','cancelled') AND reports_supported = 1
            AND (delete_requested_at IS NULL OR delete_request_key = ${claim.requestKey})
          RETURNING read_key`);
        const row = claimed[0];
        if (row !== undefined)
          return {
            _tag: "claimed" as const,
            correlationId: first.correlation_id,
            readKey: row.read_key,
          };
        const current = (yield* rows(sql`SELECT * FROM remote_dispatches
          WHERE correlation_id = ${first.correlation_id}`))[0];
        if (current === undefined) return { _tag: "missing" as const };
        if (current.reports_supported !== 1) return { _tag: "reports" as const };
        if (current.delete_request_key != null && current.delete_request_key !== claim.requestKey)
          return { _tag: "other_key" as const };
        return { _tag: "state" as const, state: current.state };
      }),
    );
  });
  const clearDelete = Effect.fn("RemoteDispatchCoordinator.clearDelete")(function* (
    correlationId: string,
    requestKey: string,
  ) {
    yield* input.withLock(
      correlationId,
      db(sql`UPDATE remote_dispatches
        SET delete_requested_at = NULL, delete_request_key = NULL, updated_at = ${yield* now}
        WHERE correlation_id = ${correlationId} AND delete_request_key = ${requestKey}`),
    );
  });
  return { claimDelete, clearDelete };
};
