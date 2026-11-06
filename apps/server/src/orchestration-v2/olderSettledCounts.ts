import { ProjectId } from "@goat/contracts";

export function olderSettledSqlCounts(
  rows: ReadonlyArray<{
    readonly project_id: string;
    readonly count: number;
    readonly side_chat_count: number;
  }>,
) {
  const counts = rows.map((row) => ({
    projectId: ProjectId.make(row.project_id),
    count: row.count,
  }));
  const sideChatCounts = rows
    .filter((row) => row.side_chat_count > 0)
    .map((row) => ({ projectId: ProjectId.make(row.project_id), count: row.side_chat_count }));
  return { counts, ...(sideChatCounts.length ? { sideChatCounts } : {}) };
}

export function olderSettledMemoryCounts(
  rows: ReadonlyArray<{
    readonly thread: {
      readonly projectId: ProjectId;
      readonly sideChatOf?: string | null | undefined;
    };
  }>,
) {
  const counts = new Map<ProjectId, number>();
  const sideChats = new Map<ProjectId, number>();
  for (const { thread } of rows) {
    counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
    if (thread.sideChatOf != null)
      sideChats.set(thread.projectId, (sideChats.get(thread.projectId) ?? 0) + 1);
  }
  return {
    counts: Array.from(counts, ([projectId, count]) => ({ projectId, count })),
    ...(sideChats.size
      ? { sideChatCounts: Array.from(sideChats, ([projectId, count]) => ({ projectId, count })) }
      : {}),
  };
}
