import type { OrchestrationV2ProjectedTurnItem, ScopedThreadRef } from "@goat/contracts";
import { useState } from "react";
import { useThreadStatus } from "~/state/entities";

export function useGoatBotSource(
  ref: ScopedThreadRef | null | undefined,
  botId: string,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
) {
  const status = useThreadStatus(ref ?? null);
  const identity = ref == null ? null : `${botId}:${ref.environmentId}:${ref.threadId}`;
  const [snapshot, setSnapshot] = useState<{ identity: string; ids: ReadonlySet<string> } | null>(
    null,
  );
  if (identity !== null && status === "live" && snapshot?.identity !== identity) {
    setSnapshot({ identity, ids: new Set(items.map(({ item }) => item.id)) });
  }
  return {
    identity,
    baselineIds:
      ref === undefined
        ? undefined
        : identity === null || status !== "live" || snapshot?.identity !== identity
          ? null
          : snapshot.ids,
    sourceIds: ref === undefined ? undefined : new Set(items.map(({ item }) => item.id)),
  };
}
