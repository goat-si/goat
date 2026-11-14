import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { useState } from "react";
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
    if (source.baselineIds === null) {
      if (newest !== null) speech.pending.set("reply", newest);
      return;
    }
    const row = newest ?? speech.pending.get("reply") ?? null;
    speech.pending.clear();
    if (row !== null) {
      setAnnouncement((previous) => ({
        identity,
        sequence: previous?.identity === identity ? previous.sequence + 1 : 1,
        row,
      }));
    }
  });
  return { announcement: announcement?.identity === identity ? announcement : null, onExposure };
}
