import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { useLayoutEffect, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import type { GoatBotSourceIds } from "./useGoatBotSource";

export function useGoatBotReplyAnnouncement(identity: string, source: GoatBotSourceIds) {
  const [speech, setSpeech] = useState(() => ({
    identity,
    eligible: new Set<string>(),
    consumed: new Set<string>(),
    pending: new Map<string, Extract<GoatBotRow, { kind: "bot" }>>(),
  }));
  const [announcement, setAnnouncement] = useState<{
    identity: string;
    sequence: number;
    row: Extract<GoatBotRow, { kind: "bot" }>;
  } | null>(null);
  if (speech.identity !== identity) {
    setSpeech({ identity, eligible: new Set(), consumed: new Set(), pending: new Map() });
    setAnnouncement(null);
  }
  const announce = useStableCallback((row: Extract<GoatBotRow, { kind: "bot" }>) => {
    setAnnouncement((previous) => ({
      identity,
      sequence: previous?.identity === identity ? previous.sequence + 1 : 1,
      row,
    }));
  });
  const onExposure = useStableCallback((exposed: ReadonlyArray<GoatBotRow>) => {
    const baseline = source.baselineIds ?? source.speechBaselineIds;
    if (baseline == null || source.sourceIds === undefined) return;
    for (const id of source.sourceIds) if (!baseline.has(id)) speech.eligible.add(id);
    let newest: Extract<GoatBotRow, { kind: "bot" }> | null = null;
    for (const row of exposed) {
      if (row.kind !== "bot" || !speech.eligible.has(row.id) || speech.consumed.has(row.id))
        continue;
      speech.consumed.add(row.id);
      newest = row;
    }
    const previous = speech.pending.get("reply");
    let row = previous ?? newest;
    if (previous && newest) {
      for (const id of source.sourceIds) {
        if (id === previous.id) row = previous;
        if (id === newest.id) row = newest;
      }
    }
    if (source.baselineIds === null) {
      if (row !== null) speech.pending.set("reply", row);
      return;
    }
    speech.pending.clear();
    if (row !== null) announce(row);
  });
  // oxlint-disable-next-line goat/react-effect-budget -- Flush the live-region update after synchronization even when the transcript has no rows.
  useLayoutEffect(() => {
    if (source.baselineIds == null) return;
    const row = speech.pending.get("reply");
    if (row === undefined) return;
    speech.pending.clear();
    announce(row);
  }, [source.baselineIds, speech, announce]);
  return { announcement: announcement?.identity === identity ? announcement : null, onExposure };
}
