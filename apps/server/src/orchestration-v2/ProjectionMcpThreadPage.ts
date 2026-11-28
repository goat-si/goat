import {
  isSideChatThread,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ShellSnapshotOptions, ShellSnapshotRead } from "./ProjectionStore.ts";
import { makeShellThreadRows } from "./ProjectionShellThreadRows.ts";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export type McpPageStatus = "preparing" | "starting" | "running";

export interface McpThreadPageInput {
  readonly projectId?: ProjectId | undefined;
  readonly includeSubagents: boolean;
  readonly settled?: boolean | undefined;
  readonly statuses?: ReadonlyArray<McpPageStatus> | undefined;
  readonly threadIds?: ReadonlyArray<ThreadId> | undefined;
  readonly offset: number;
  readonly limit: number;
}

export interface McpThreadPage {
  readonly total: number;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}
export type PageOperation<E> = (input: McpThreadPageInput) => Effect.Effect<McpThreadPage, E>;

export const selectPage = Effect.fn("ProjectionMcpThreadPage.selectPage")(function* <E>(
  sql: SqlClient.SqlClient,
  readShells: (
    options: ShellSnapshotOptions,
  ) => Effect.Effect<Effect.Effect<ShellSnapshotRead, E>, E>,
  input: McpThreadPageInput,
) {
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const project =
          input.projectId === undefined ? sql`` : sql`AND project_id = ${input.projectId}`;
        const threadIds =
          input.threadIds === undefined
            ? sql``
            : sql`
        AND thread_id IN (SELECT value FROM json_each(${encodeIds(input.threadIds)}))`;
        const listed = input.includeSubagents
          ? sql``
          : sql`
      AND json_extract(payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
      AND json_extract(payload_json, '$.sideChatOf') IS NULL`;
        const settled =
          input.settled === undefined
            ? sql``
            : input.settled
              ? sql`AND json_extract(payload_json, '$.settledOverride') IS 'settled'`
              : sql`AND json_extract(payload_json, '$.settledOverride') IS NOT 'settled'`;
        const { isSilentShellRun } = makeShellThreadRows(sql);
        const statuses =
          input.statuses === undefined
            ? sql``
            : sql`
      AND (SELECT r.status FROM orchestration_v2_projection_runs r
        INDEXED BY orchestration_v2_projection_runs_thread_status_idx
        WHERE r.thread_id = orchestration_v2_projection_threads.thread_id
          AND r.status IN ('preparing', 'starting', 'running', 'waiting')
          AND NOT ${isSilentShellRun("r")}
        ORDER BY r.ordinal DESC, r.run_id DESC LIMIT 1)
        IN (SELECT value FROM json_each(${encodeIds(input.statuses)}))`;
        const count = yield* sql<{ readonly total: number }>`
      SELECT COUNT(*) AS total FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND archived_at IS NULL ${project} ${listed} ${threadIds} ${settled} ${statuses}
    `;
        const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND archived_at IS NULL ${project} ${listed} ${threadIds} ${settled} ${statuses}
      ORDER BY updated_at DESC, thread_id DESC LIMIT ${input.limit} OFFSET ${input.offset}
    `;
        const ids = rows.map((row) => ThreadId.make(row.thread_id));
        const decode = yield* readShells({ location: "active", threadIds: ids });
        return { ids, total: count[0]?.total ?? 0, decode };
      }),
    )
    .pipe(
      Effect.flatMap(({ ids, total, decode }) =>
        decode.pipe(
          Effect.map((snapshot) => {
            const byId = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
            return {
              total,
              threads: ids.flatMap((id) => {
                const thread = byId.get(id);
                return thread === undefined ? [] : [thread];
              }),
            } satisfies McpThreadPage;
          }),
        ),
      ),
    );
});

export const memoryPage = (
  snapshot: ShellSnapshotRead,
  input: McpThreadPageInput,
): McpThreadPage => {
  const threads = snapshot.threads
    .filter(
      (thread) =>
        (input.projectId === undefined || thread.projectId === input.projectId) &&
        (input.threadIds === undefined || input.threadIds.includes(thread.id)) &&
        (input.statuses === undefined ||
          (thread.activityRunStatus != null &&
            input.statuses.some((status) => status === thread.activityRunStatus))) &&
        (input.settled === undefined || (thread.settledOverride === "settled") === input.settled) &&
        (input.includeSubagents ||
          (thread.lineage.relationshipToParent !== "subagent" && !isSideChatThread(thread))),
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
        (left.id === right.id ? 0 : left.id < right.id ? 1 : -1),
    );
  return {
    total: threads.length,
    threads: threads.slice(input.offset, input.offset + input.limit),
  };
};
