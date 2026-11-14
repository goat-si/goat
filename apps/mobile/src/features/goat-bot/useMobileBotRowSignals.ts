import { useAtomValue } from "@effect/atom-react";
import { homeWorkGoverns } from "@goat/client-runtime/goatBot";
import type { BotId, EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";

import { channelEnvironment } from "../../state/channels";
import { mobileGoatBotHomeWorkByEnvironment } from "../../state/goatBotHomeWork";

const NOT_GOVERNED = Atom.make(false).pipe(Atom.withLabel("mobile-goat-bot-governed:none"));
const NO_UNREAD = Atom.make<number | "pending" | "unavailable">("pending").pipe(
  Atom.withLabel("mobile-goat-bot-row-unread:none"),
);

/** Whether Home governs an environment, as one boolean: its readers re-render only when it flips. */
export const mobileGoatBotGovernedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => homeWorkGoverns(get(mobileGoatBotHomeWorkByEnvironment(environmentId)))).pipe(
    Atom.withLabel(`mobile-goat-bot-governed:${environmentId}`),
  ),
);

export type MobileBotRowSignals = {
  /** Unread tasks in the bot's recent work, when known. */
  readonly unread: number | null;
  /** Which of the row's counts cannot be read, when any. */
  readonly missing: string | null;
  /** The same, for the row's spoken label. */
  readonly spoken: ReadonlyArray<string>;
};

/**
 * A bot row's work signals, only where Home governs its environment (roster known, every bot
 * eligible); elsewhere null and nothing of the bot's work is read, so the row is as it was. The row
 * reads the derived unread count, not the bot's whole work.
 */
export function useMobileBotRowSignals(input: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: BotId;
  /** The waiting count's own read, for a row that shows one. */
  readonly waiting?: "ready" | "pending" | "unavailable";
}): MobileBotRowSignals | null {
  const { environmentId, botId } = input;
  const governed = useAtomValue(
    environmentId === null ? NOT_GOVERNED : mobileGoatBotGovernedAtom(environmentId),
  );
  const signal = useAtomValue(
    governed && environmentId !== null
      ? channelEnvironment.homeCurrentUnreadAtom([environmentId, botId])
      : NO_UNREAD,
  );
  if (!governed) return null;
  const unread = typeof signal === "number" ? signal : null;
  const unavailable = [
    signal === "unavailable" ? "Unread" : null,
    input.waiting === "unavailable" ? "waiting" : null,
  ].filter((part) => part !== null);
  const missing = unavailable.length > 0 ? `${unavailable.join(" and ")} unavailable` : null;
  return {
    unread,
    missing,
    spoken: [
      unread !== null && unread > 0
        ? `${unread} unread task${unread === 1 ? "" : "s"}; recent work only; older work may be missing`
        : null,
      missing,
    ].filter((part) => part !== null),
  };
}
