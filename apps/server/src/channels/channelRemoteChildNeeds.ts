/**
 * Needs-you already stored for work on another machine. Reconcile reads
 * remote_dispatches and never opens SSH. A missing row, a blank observation, or
 * reports_supported = 0 is unread and leaves what the task already shows.
 *
 * @module channelRemoteChildNeeds
 */
import {
  type ChannelChildWork,
  type ChannelTaskNeedsYou,
  ChannelWorkerObservation,
  type EnvironmentId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { withApprovalHost } from "./channelWorkerObservation.ts";

const decodeStoredObservation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ChannelWorkerObservation),
);
const REMOTE_LAUNCH_SURFACES: ReadonlySet<ChannelChildWork["surface"]> = new Set([
  "ssh_thread_launch",
  "delegate_remote",
]);

export interface RemoteChildRef {
  readonly correlationId: string;
  readonly host: string;
  readonly environmentId?: EnvironmentId | undefined;
}

export const remoteLaunchChild = (
  record: ChannelChildWork,
  generation: number,
): RemoteChildRef | undefined => {
  if (record.generation !== generation || !REMOTE_LAUNCH_SURFACES.has(record.surface))
    return undefined;
  const { correlationId, host, environmentId } = record.destination ?? {};
  if (correlationId === undefined || host === undefined) return undefined;
  return { correlationId, host, environmentId };
};

type StoredRead =
  | { readonly status: "unread" }
  | { readonly status: "read"; readonly needsYou: ReadonlyArray<ChannelTaskNeedsYou> };

/** This generation's ssh-launched and remote-delegated children, one per dispatch. */
export const remoteLaunchChildren = (
  records: ReadonlyArray<ChannelChildWork> | "unknown",
  generation: number,
): ReadonlyArray<RemoteChildRef> => {
  if (records === "unknown") return [];
  const seen = new Set<string>();
  return records.flatMap((record) => {
    const child = remoteLaunchChild(record, generation);
    if (child === undefined || seen.has(child.correlationId)) return [];
    seen.add(child.correlationId);
    return [child];
  });
};

const readStored = (sql: SqlClient.SqlClient, correlationId: string) =>
  sql<{
    readonly observation: string | null;
    readonly reports_supported: number | null;
    readonly delete_requested_at: string | null;
    readonly end_reason: string | null;
  }>`
    SELECT observation, reports_supported, delete_requested_at, end_reason FROM remote_dispatches
    WHERE correlation_id = ${correlationId} AND kind IN ('task', 'thread')
    LIMIT 1
  `.pipe(
    Effect.flatMap((rows): Effect.Effect<StoredRead> => {
      const row = rows[0];
      // A recorded delete, or tracking that ended, is a known empty read. A missing row or blank
      // observation stays unread.
      if (
        row !== undefined &&
        ((row.delete_requested_at != null && row.delete_requested_at !== "") ||
          row.end_reason != null)
      ) {
        return Effect.succeed({ status: "read" as const, needsYou: [] });
      }
      if (
        row === undefined ||
        row.reports_supported === 0 ||
        row.observation == null ||
        row.observation === ""
      ) {
        return Effect.succeed({ status: "unread" });
      }
      return decodeStoredObservation(row.observation).pipe(
        Effect.map((observation) => ({ status: "read" as const, needsYou: observation.needsYou })),
        Effect.orElseSucceed(() => ({ status: "unread" as const })),
      );
    }),
    Effect.orElseSucceed(() => ({ status: "unread" as const })),
  );

/** A remote subagent's stored needs. An unread dispatch contributes nothing. */
export const storedRemoteNeeds = Effect.fn("channelRemoteChildNeeds.stored")(function* (
  sql: SqlClient.SqlClient,
  correlationId: string,
) {
  const read = yield* readStored(sql, correlationId);
  return read.status === "read" ? read.needsYou : [];
});

const mergeLaunchNeeds = (
  previous: ReadonlyArray<ChannelTaskNeedsYou> | undefined,
  reads: ReadonlyArray<RemoteChildRef & { readonly read: StoredRead }>,
): ReadonlyArray<ChannelTaskNeedsYou> => {
  const fresh: Array<ChannelTaskNeedsYou> = [];
  const seen = new Map<string, "read" | "unread">();
  for (const item of reads) {
    const prior = seen.get(item.host);
    if (item.read.status === "unread") seen.set(item.host, "unread");
    else if (prior !== "unread") seen.set(item.host, "read");
    if (item.read.status === "read")
      fresh.push(...withApprovalHost(item.read.needsYou, item.host, item.environmentId));
  }
  const freshIds = new Set(fresh.flatMap((need) => need.approval?.requestId ?? []));
  const kept = (previous ?? []).filter((need) => {
    const host = need.approval?.host;
    const requestId = need.approval?.requestId;
    if (host === undefined || requestId === undefined || freshIds.has(requestId)) return false;
    return seen.get(host) === "unread";
  });
  return [...fresh, ...kept];
};

/** Stored needs for ssh-launched and remote-delegated children, stamped with their host. */
export const launchObservationNeeds = Effect.fn("channelRemoteChildNeeds.launch")(function* (
  sql: SqlClient.SqlClient,
  children: ReadonlyArray<RemoteChildRef>,
  previous: ReadonlyArray<ChannelTaskNeedsYou> | undefined,
) {
  const reads = yield* Effect.forEach(
    children,
    (child) =>
      readStored(sql, child.correlationId).pipe(Effect.map((read) => ({ ...child, read }))),
    { concurrency: 1 },
  );
  return mergeLaunchNeeds(previous, reads);
});
