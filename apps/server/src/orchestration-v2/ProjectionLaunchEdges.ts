import {
  OrchestrationV2AppThreadLineage,
  type OrchestrationV2AppThread,
  OrchestrationV2ThreadLauncher,
  ProjectId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

/** How an active thread hangs off others, without its runs or counts: enough to walk a lineage. */
export interface ProjectionLaunchEdge {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly lineage: OrchestrationV2AppThreadLineage;
  readonly launchedBy?: OrchestrationV2ThreadLauncher | undefined;
  readonly pinnedAt: string | null;
}

const decodeLauncher = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ThreadLauncher),
);
const decodeRelationship = Schema.decodeUnknownOption(
  OrchestrationV2AppThreadLineage.fields.relationshipToParent,
);

interface LaunchEdgeRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly parent_thread_id: string | null;
  readonly relationship: string | null;
  readonly root_thread_id: string;
  readonly launched_by: string | null;
  readonly pinned_at: string | null;
}

const edgeOfRow = (row: LaunchEdgeRow): ProjectionLaunchEdge => {
  const launchedBy = row.launched_by === null ? Option.none() : decodeLauncher(row.launched_by);
  return {
    id: ThreadId.make(row.thread_id),
    projectId: ProjectId.make(row.project_id),
    lineage: {
      parentThreadId: row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id),
      relationshipToParent: Option.getOrNull(decodeRelationship(row.relationship)),
      rootThreadId: ThreadId.make(row.root_thread_id),
    },
    ...(Option.isSome(launchedBy) ? { launchedBy: launchedBy.value } : {}),
    pinnedAt: row.pinned_at,
  };
};

export const selectLaunchEdges = (sql: SqlClient.SqlClient) =>
  sql<LaunchEdgeRow>`
    SELECT thread_id, project_id,
      json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
      json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship,
      COALESCE(json_extract(payload_json, '$.lineage.rootThreadId'), thread_id) AS root_thread_id,
      json_extract(payload_json, '$.launchedBy') AS launched_by,
      json_extract(payload_json, '$.pinnedAt') AS pinned_at
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND json_extract(payload_json, '$.archivedAt') IS NULL
  `.pipe(Effect.map((rows) => rows.map(edgeOfRow)));

export const launchEdgeOfThread = (
  thread: Pick<
    OrchestrationV2AppThread,
    "id" | "projectId" | "lineage" | "launchedBy" | "pinnedAt"
  >,
): ProjectionLaunchEdge => ({
  id: thread.id,
  projectId: thread.projectId,
  lineage: thread.lineage,
  ...(thread.launchedBy === undefined ? {} : { launchedBy: thread.launchedBy }),
  pinnedAt: thread.pinnedAt == null ? null : String(thread.pinnedAt),
});
