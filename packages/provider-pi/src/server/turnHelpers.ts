import type { PiCompactCommand } from "./commands.ts";
import type { PiRpcRecord } from "./rpc.ts";
import type { ActivePiTurn } from "./turnState.ts";

export const compactRpcRecord = (command: PiCompactCommand): PiRpcRecord =>
  command.customInstructions === undefined
    ? { type: "compact" }
    : { type: "compact", customInstructions: command.customInstructions };

export const itemOrdinal = (turn: ActivePiTurn, nativeItemId: string): number => {
  const existing = turn.itemOrdinals.get(nativeItemId);
  if (existing !== undefined) return existing;
  const ordinal = turn.nextItemOrdinal++;
  turn.itemOrdinals.set(nativeItemId, ordinal);
  return ordinal;
};

export const compactionNativeItemId = (turn: ActivePiTurn): string =>
  `compaction:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;
