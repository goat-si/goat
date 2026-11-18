import { useState } from "react";

interface DraftOwner {
  readonly botId: string | null;
  readonly taskId: string | null;
  /** Where the message would go; null while the session has not resolved it. */
  readonly destination: string | null;
  /** Counts owner changes; what the draft's files, picks and answering are keyed on. */
  readonly generation: number;
}

/**
 * Who the message being written belongs to: the bot or member and task shown, and the destination
 * the session sends to. A different bot, task or destination drops the draft; a destination that
 * goes missing for a while, resolves for the first time or is confirmed again keeps it.
 */
export function useGoatBotDraftOwner(
  current: {
    readonly botId: string | null;
    readonly taskId: string | null;
    readonly environmentId: string | null;
    readonly threadId: string | null;
  },
  onChange: () => void,
): number {
  const destination =
    current.environmentId === null || current.threadId === null
      ? null
      : JSON.stringify([current.environmentId, current.threadId]);
  const [owner, setOwner] = useState<DraftOwner>({
    botId: current.botId,
    taskId: current.taskId,
    destination,
    generation: 0,
  });
  const changed =
    owner.botId !== current.botId ||
    owner.taskId !== current.taskId ||
    (destination !== null && owner.destination !== null && destination !== owner.destination);
  // Set during render, before the new owner's screen commits, so the old draft is never shown for it.
  if (changed) {
    setOwner({
      botId: current.botId,
      taskId: current.taskId,
      destination,
      generation: owner.generation + 1,
    });
    onChange();
  } else if (destination !== null && owner.destination === null) {
    setOwner({ ...owner, destination });
  }
  return changed ? owner.generation + 1 : owner.generation;
}
