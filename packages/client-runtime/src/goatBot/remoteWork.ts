import type { BotRemoteWork, ChannelChildWorkState, EnvironmentId } from "@goat/contracts";

import type { GoatBotWorkRef } from "./visibility.ts";

/** Where a client can take the bot's work on another machine, if anywhere. */
export type RemoteBotWorkTarget =
  | { readonly kind: "open"; readonly host: string; readonly ref: GoatBotWorkRef }
  | {
      readonly kind: "unavailable";
      readonly host: string;
      /** How a launch that ended went, or "Unavailable" while it may still run. */
      readonly label: string;
    };

// A launch that lost its host or was dismissed is listed as ended; it says so rather than wait.
const ENDED: Partial<Record<ChannelChildWorkState, string>> = {
  completed: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  released: "Not started",
};

/**
 * The one rule that opens, and so may hide, the bot's work on another machine. Its host is the
 * bot's own SSH alias, which means nothing to this client, so only the environment id the
 * destination itself reported can open it, and only while this client is connected to that
 * environment. Everything else is shown by host as unavailable.
 */
export function resolveRemoteBotWork(
  item: BotRemoteWork,
  isOpenable: (environmentId: EnvironmentId) => boolean,
): RemoteBotWorkTarget {
  if (item.threadId == null || item.environmentId == null || !isOpenable(item.environmentId))
    return { kind: "unavailable", host: item.host, label: ENDED[item.state] ?? "Unavailable" };
  return {
    kind: "open",
    host: item.host,
    ref: { environmentId: item.environmentId, threadId: item.threadId },
  };
}
