import { OrchestrationV2AppThreadJson, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import type * as SqlClient from "effect/sql/SqlClient";
import { threadPullRequestsOf } from "../sourceControl/threadPullRequests.ts";

const PullRequestThread = OrchestrationV2AppThreadJson.mapFields(
  ({
    id,
    projectId,
    lineage,
    createdAt,
    branch,
    worktreePath,
    archivedAt,
    settledOverride,
    settledAt,
    linkedPullRequest,
    branchPullRequest,
    pullRequests,
  }) => ({
    id,
    projectId,
    lineage,
    createdAt,
    branch,
    worktreePath,
    archivedAt,
    settledOverride,
    settledAt,
    linkedPullRequest,
    branchPullRequest,
    pullRequests,
  }),
);
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequestThread));
export type PullRequestThread = typeof PullRequestThread.Type;
export type PullRequestSnapshotOptions = {
  readonly threadId?: ThreadId;
  readonly unsettledOnly?: boolean;
};
export type PullRequestSnapshot = {
  readonly snapshotSequence: number;
  readonly threads: ReadonlyArray<PullRequestThread>;
};

export const readPullRequestSnapshot = Effect.fn("ProjectionStore.readPullRequestSnapshot")(
  function* (
    sql: SqlClient.SqlClient,
    { threadId, unsettledOnly = false }: PullRequestSnapshotOptions,
  ) {
    const { rows, sequenceRows } = yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT t.payload_json FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL${
        threadId === undefined
          ? sql` AND json_extract(t.payload_json, '$.archivedAt') IS NULL`
          : sql` AND t.thread_id = ${threadId}`
      }${
        unsettledOnly
          ? sql` AND json_extract(t.payload_json, '$.settledAt') IS NULL AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'`
          : sql``
      }
      ORDER BY t.updated_at ASC, t.thread_id ASC
    `;
        const sequenceRows = yield* sql<{ readonly snapshot_sequence: number | null }>`
      SELECT MAX(sequence) AS snapshot_sequence FROM orchestration_events
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
    `;
        return { rows, sequenceRows };
      }),
    );
    const threads = yield* Effect.forEach(rows, (row) =>
      decode(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, pullRequests: threadPullRequestsOf(thread) })),
      ),
    );
    return { snapshotSequence: sequenceRows[0]?.snapshot_sequence ?? 0, threads };
  },
);

export interface PullRequestSnapshotReader<E> {
  readonly getPullRequestSnapshot: (
    options: PullRequestSnapshotOptions,
  ) => Effect.Effect<PullRequestSnapshot, E>;
}

export const memoryPullRequestSnapshot = Effect.fn("ProjectionStore.getPullRequestSnapshot")(
  function* (
    state: import("effect/Ref").Ref<import("./ProjectionStore.ts").ProjectionReplayState>,
    sequence: import("effect/Ref").Ref<number>,
    options: PullRequestSnapshotOptions,
  ) {
    const existing = (yield* Ref.get(state)).projections;
    const threads = [...existing.values()]
      .map(({ thread }) => thread)
      .filter(
        (thread) =>
          thread.deletedAt === null &&
          (options.threadId === undefined
            ? thread.archivedAt === null
            : thread.id === options.threadId) &&
          (!options.unsettledOnly ||
            (thread.settledAt === null && thread.settledOverride !== "settled")),
      )
      .map((thread) => ({ ...thread, pullRequests: threadPullRequestsOf(thread) }));
    return { snapshotSequence: yield* Ref.get(sequence), threads };
  },
);

export function orchestratorPullRequestSnapshot<E, E2>(
  store: PullRequestSnapshotReader<E>,
  mapError: (error: E) => E2,
): PullRequestSnapshotReader<E2> {
  return {
    getPullRequestSnapshot: Effect.fn("OrchestratorV2.getPullRequestSnapshot")((options) =>
      store.getPullRequestSnapshot(options).pipe(Effect.mapError(mapError)),
    ),
  };
}

export function makeProjectionReplayState(): import("./ProjectionStore.ts").ProjectionReplayState {
  return {
    projections: new Map(),
    providerSessionThreadIds: new Map(),
    providerThreadInstanceIds: new Map(),
  };
}
