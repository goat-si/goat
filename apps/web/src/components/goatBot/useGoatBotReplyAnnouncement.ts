import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import type { GoatBotSourceIds } from "./useGoatBotSource";

export function useGoatBotReplyAnnouncement(identity: string, source: GoatBotSourceIds) {
  const [speech, setSpeech] = useState(() => ({
    identity,
    eligible: new Set<string>(),
    consumed: new Set<string>(),
  }));
  const [announcement, setAnnouncement] = useState<{
    identity: string;
    sequence: number;
    row: Extract<GoatBotRow, { kind: "bot" }>;
  } | null>(null);
  const pending = useRef<{ identity: string; row: Extract<GoatBotRow, { kind: "bot" }> } | null>(
    null,
  );
  if (speech.identity !== identity) {
    setSpeech({ identity, eligible: new Set(), consumed: new Set() });
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
      if (newest !== null) pending.current = { identity, row: newest };
      return;
    }
    const row = newest ?? (pending.current?.identity === identity ? pending.current.row : null);
    pending.current = null;
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
