import type { OrchestrationV2ProjectedTurnItem, ScopedThreadRef } from "@goat/contracts";
import { useState } from "react";
import { useThreadStatus } from "~/state/entities";
import { localSendRows } from "./useGoatBotFollow";

/** What decides which rows are new: the displayed thread's first-live history and its items. */
export interface GoatBotSourceIds {
  readonly identity: string | null;
  readonly baselineIds: ReadonlySet<string> | null | undefined;
  readonly sourceIds: ReadonlySet<string> | undefined;
}

export function useGoatBotSource(
  ref: ScopedThreadRef | null | undefined,
  botId: string,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  membership: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = items,
) {
  const status = useThreadStatus(ref ?? null);
  const identity = ref == null ? null : `${botId}:${ref.environmentId}:${ref.threadId}`;
  // The compiler memoizes these on the membership list, which keeps its identity while text streams.
  const sourceIds = new Set(membership.map(({ item }) => item.id));
  const committedSends = localSendRows(membership);
  const [snapshot, setSnapshot] = useState<{ identity: string; ids: ReadonlySet<string> } | null>(
    null,
  );
  if (identity !== null && status === "live" && snapshot?.identity !== identity) {
    // The baseline comes from the projection that reports readiness.
    setSnapshot({ identity, ids: new Set(membership.map(({ item }) => item.id)) });
  }
  return {
    identity,
    baselineIds:
      ref === undefined
        ? undefined
        : identity === null || status !== "live" || snapshot?.identity !== identity
          ? null
          : snapshot.ids,
    sourceIds: ref === undefined ? undefined : sourceIds,
    committedSends,
  };
}
