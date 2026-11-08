/**
 * A thread dispatch's last observation. The row's current run is known_run_id:
 * a thread keeps taking turns, so this is not limited to the launch run. An older
 * remote that omits the field leaves the stored observation alone.
 *
 * @module remoteThreadObservation
 */
import {
  ChannelWorkerObservation,
  type RemoteKnownRun,
  type RemoteObservedRun,
  type RunId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type { RemoteDispatchRow } from "./remoteDispatchRow.ts";

const encodeObservation = Schema.encodeSync(Schema.fromJsonString(ChannelWorkerObservation));

/** Echoed on the next wait. Omitted when unset, so an older remote is not released every call. */
export const threadKnownRun = (
  row: Pick<RemoteDispatchRow, "known_run_id" | "known_run_status" | "observation">,
): RemoteKnownRun | null =>
  row.known_run_id === null || row.known_run_status === null
    ? null
    : {
        runId: row.known_run_id,
        status: row.known_run_status,
        ...(row.observation == null ? {} : { observation: row.observation }),
      };

export const persistThreadObservation = Effect.fn("remoteThreadObservation.persist")(function* (
  sql: SqlClient.SqlClient,
  correlationId: string,
  knownRunId: RunId | null,
  observed: RemoteObservedRun | null,
) {
  if (
    observed === null ||
    observed.observation === undefined ||
    knownRunId === null ||
    observed.runId !== knownRunId
  ) {
    return;
  }
  yield* sql`UPDATE remote_dispatches SET
    observation = ${encodeObservation(observed.observation)}
    WHERE correlation_id = ${correlationId}`;
});
