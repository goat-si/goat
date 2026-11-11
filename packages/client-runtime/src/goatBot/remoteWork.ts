import type { BotRemoteWork, EnvironmentId } from "@goat/contracts";

import type { GoatBotWorkRef } from "./visibility.ts";

/** Where a client can take the bot's work on another machine, if anywhere. */
export type RemoteBotWorkTarget =
  | { readonly kind: "open"; readonly host: string; readonly ref: GoatBotWorkRef }
  | { readonly kind: "unavailable"; readonly host: string };

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
  if (
    item.threadId === undefined ||
    item.environmentId === undefined ||
    !isOpenable(item.environmentId)
  )
    return { kind: "unavailable", host: item.host };
  return {
    kind: "open",
    host: item.host,
    ref: { environmentId: item.environmentId, threadId: item.threadId },
  };
}
