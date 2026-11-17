import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import type { ScopedThreadRef } from "@goat/contracts";

import { useQuietThreadShell } from "../state/entities";

/**
 * Whether the open thread is a run fork whose source the client holds no shell for. An older
 * settled source sits outside the shell window; the fork's family read brings it.
 */
export function useForkSourceMissing(
  threadRef: ScopedThreadRef | null,
  thread: Pick<EnvironmentThreadShell, "forkedFrom"> | null,
): boolean {
  const sourceRef =
    threadRef !== null && thread?.forkedFrom?.type === "run"
      ? scopeThreadRef(threadRef.environmentId, thread.forkedFrom.threadId)
      : null;
  return useQuietThreadShell(sourceRef) === null && sourceRef !== null;
}
