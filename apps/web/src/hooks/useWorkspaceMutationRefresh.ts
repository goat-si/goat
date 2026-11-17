import { useEffect, useRef } from "react";

function workspaceMutationRefreshToken(
  resourceKey: string,
  mutationId: string | null,
): string | null {
  return mutationId === null ? null : `${resourceKey}\u0000${mutationId}`;
}

export function useWorkspaceMutationRefresh(input: {
  readonly enabled?: boolean;
  readonly mutationId: string | null;
  readonly refresh: () => void;
  readonly resourceKey: string;
  /** Takes the first token as the baseline instead of refreshing for it. */
  readonly skipFirst?: boolean;
}): void {
  const { enabled = true, mutationId, refresh, resourceKey, skipFirst = false } = input;
  const handledTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const token = workspaceMutationRefreshToken(resourceKey, mutationId);
    if (token === null || token === handledTokenRef.current) return;
    const first = handledTokenRef.current === null;
    handledTokenRef.current = token;
    if (!(skipFirst && first)) refresh();
  }, [enabled, mutationId, refresh, resourceKey, skipFirst]);
}
