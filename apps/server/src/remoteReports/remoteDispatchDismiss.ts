import type { ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import type * as SqlClient from "effect/sql/SqlClient";

import type { RemoteDispatchRecord } from "./remoteDispatchModel.ts";
import { CONTACT_GAP_MS } from "./remoteDispatchOutage.ts";

/**
 * A thread dispatch GOAT can stop following without its host: the remote thread is known and the
 * host is not answering, or tracking already ended for it. A launch whose outcome is unknown is
 * never dismissable; only its destination's fence settles it.
 */
export const isDismissable = (record: RemoteDispatchRecord) =>
  record.kind === "thread" &&
  record.remoteThreadId !== null &&
  record.endReason !== "dismissed" &&
  (record.state === "lost" || (record.state === "running" && record.hostUnavailableSince !== null));

export interface DismissSelector {
  readonly host: string;
  readonly remoteThreadId: string;
  /** Set for an agent: only the calling thread's own launches. */
  readonly originThreadId?: ThreadId;
  /** Only a host silent at least this long, or a launch GOAT already stopped following. */
  readonly unreachableForMs?: number;
}

/** An agent's unwatch dismisses only past this: a shorter blip means it just drops its wakes. */
export const AGENT_DISMISS_AFTER_MS = 15 * 60_000;

/**
 * With a cutoff, only an outage that began by cutoff.since and whose latest failed contact is
 * after cutoff.failedAfter: an old start alone may only mean this machine was away since.
 */
export interface DismissCutoff {
  readonly since: string;
  readonly failedAfter: string;
}
export const dismissCutoff = (
  now: DateTime.Utc,
  unreachableForMs: number | undefined,
): DismissCutoff | null =>
  unreachableForMs === undefined
    ? null
    : {
        since: DateTime.formatIso(DateTime.subtract(now, { milliseconds: unreachableForMs })),
        failedAfter: DateTime.formatIso(DateTime.subtract(now, { milliseconds: CONTACT_GAP_MS })),
      };
const dismissableNow = (sql: SqlClient.SqlClient, cutoff: DismissCutoff | null) =>
  sql`(state = 'lost' OR (state = 'running' AND host_unavailable_since IS NOT NULL
    AND (${cutoff?.since ?? null} IS NULL OR (host_unavailable_since <= ${cutoff?.since ?? null}
      AND host_last_failed_at >= ${cutoff?.failedAfter ?? null}))))`;

export const selectDismissable = (
  sql: SqlClient.SqlClient,
  selector: DismissSelector,
  cutoff: DismissCutoff | null,
) =>
  sql`SELECT * FROM remote_dispatches WHERE kind = 'thread' AND host = ${selector.host}
    AND remote_thread_id = ${selector.remoteThreadId}
    AND (${selector.originThreadId ?? null} IS NULL OR origin_thread_id = ${selector.originThreadId ?? null})
    AND (end_reason IS NULL OR end_reason = 'host_unreachable')
    AND ${dismissableNow(sql, cutoff)}`;

/** Ends tracking of one dispatch still dismissable now; returns the dismissed row, or nothing. */
export const dismissRow = (
  sql: SqlClient.SqlClient,
  correlationId: string,
  at: string,
  cutoff: DismissCutoff | null,
) =>
  sql`UPDATE remote_dispatches SET state = 'cancelled', end_reason = 'dismissed', ended_at = ${at},
    updated_at = ${at}, observation = NULL,
    last_error = 'Dismissed without contacting ' || host || '.' || CASE
      WHEN host_unavailable_since IS NULL THEN ''
      ELSE ' It had not answered since ' || host_unavailable_since || '.' END
    WHERE correlation_id = ${correlationId} AND kind = 'thread' AND remote_thread_id IS NOT NULL
      AND (end_reason IS NULL OR end_reason = 'host_unreachable')
      AND ${dismissableNow(sql, cutoff)}
    RETURNING *`;
