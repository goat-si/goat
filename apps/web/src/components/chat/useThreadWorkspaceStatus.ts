import type { ScopedThreadRef } from "@goat/contracts";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useWorkspaceMutationRefresh } from "../../hooks/useWorkspaceMutationRefresh";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function useThreadWorkspaceStatus(
  threadRef: ScopedThreadRef | null,
  worktreePath: string | null,
  supported: boolean,
  runKey: string,
) {
  const query = useEnvironmentQuery(
    threadRef && worktreePath && supported
      ? serverEnvironment.threadWorkspaceStatus({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  useWorkspaceMutationRefresh({
    enabled: Boolean(threadRef && worktreePath && supported),
    mutationId: runKey,
    resourceKey: `thread-workspace:${threadRef?.environmentId}:${threadRef?.threadId}`,
    refresh: query.refresh,
  });
  // While the worktree needs attention, follow the server: a restore elsewhere or a repair on disk
  // shows up on focus and every half minute, without waiting for the next run.
  useLiveRefresh(query.refresh, {
    enabled:
      query.data?.state === "cleaned" ||
      query.data?.state === "missing" ||
      query.data?.setupIncomplete === true,
    intervalMs: 30_000,
  });
  return query;
}

export function workspaceUnavailable(
  state: string | undefined,
  worktreePath: string | null,
  cwd: string | null,
) {
  return (
    worktreePath !== null && worktreePath === cwd && (state === "cleaned" || state === "missing")
  );
}
