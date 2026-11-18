import { useAtomMount } from "@effect/atom-react";
import { createVcsStatusRevalidationAtomFamily } from "@goat/client-runtime/state/vcs";
import type { EnvironmentId } from "@goat/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { subscribeDocumentReturn } from "../../lib/documentActivity";
import { vcsEnvironment } from "../../state/vcs";
import { useRetainedValue } from "../Sidebar.logic";

const vcsBranchRevalidation = createVcsStatusRevalidationAtomFamily({
  refreshStatus: vcsEnvironment.refreshBranch,
  subscribeWake: subscribeDocumentReturn,
  wakeDebounceMs: 250,
});

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

export function withoutRemovedCheckout<
  T extends { readonly branch: string | null; readonly worktreePath: string | null },
>(thread: T, gitStatus: { readonly isRepo?: boolean | undefined } | null): T {
  return gitStatus?.isRepo === false ? { ...thread, branch: null, worktreePath: null } : thread;
}
