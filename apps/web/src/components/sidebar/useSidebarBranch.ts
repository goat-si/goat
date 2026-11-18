import { useAtomMount } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { vcsBranchRevalidation, vcsEnvironment } from "../../state/vcs";
import { useRetainedValue } from "../Sidebar.logic";

export function useSidebarBranch(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  },
  cwd: string | null,
  leased: boolean,
) {
  const { environmentId } = thread;
  const target =
    leased && cwd !== null && (thread.branch != null || thread.worktreePath !== null)
      ? { environmentId, cwd }
      : null;
  const status = useEnvironmentQuery(
    target === null ? null : vcsEnvironment.branch({ environmentId, input: { cwd: target.cwd } }),
  );
  useAtomMount(vcsBranchRevalidation(target));
  return useRetainedValue(JSON.stringify([environmentId, cwd]), status.data);
}
