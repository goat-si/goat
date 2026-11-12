import { botRosterGroups, findMemberBot } from "@goat/client-runtime/goatBot";
import type { BotProfile, EnvironmentId, ThreadId } from "@goat/contracts";

import { useEnvironment } from "~/state/environments";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";
import { useNewBotSlot } from "./useNewBotSlot";

// Member conversations get stable ids with this prefix (apps/server/src/channels/channelIds.ts,
// memberBotLaunchIdsFor). Used only to wait for the bot list, never to decide a thread is a bot.
const MEMBER_THREAD_PREFIX = "channel-member-bot:";

/**
 * The member bot whose thread this is, deleted ones included, from the roster's cached list, or
 * this client's create until the list holds it. A thread that may be a member's is `pending` until
 * that list answers and `unavailable` if it cannot be read.
 */
export function useGoatBotMemberAt(
  target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
  /** The thread is the main bot's, so its chat needs the main profile's name. */
  mainThread = false,
): {
  readonly member: BotProfile | null;
  /** The main bot's profile from the same list, which names the main chat. */
  readonly main: BotProfile | null;
  readonly pending: boolean;
  readonly unavailable: boolean;
  /** Reads the bot list again; null while the computer is unreachable, since GOAT reconnects itself. */
  readonly retry: (() => void) | null;
} {
  const environmentId = target?.environmentId ?? null;
  const presentation = useEnvironment(environmentId);
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  const supported = environmentId !== null && capabilities?.goatBotMembers === true;
  // The roster's own list (useBotRoster). Without members, only the main bot's thread reads it,
  // for its name, and only while connected, as the roster does.
  const readsMain =
    mainThread &&
    presentation?.connection.phase === "connected" &&
    capabilities?.goatBotProfiles === true;
  const profiles = useEnvironmentQuery(
    environmentId !== null && (supported || readsMain)
      ? channelEnvironment.listBots({
          environmentId,
          input: supported ? { includeDeleted: true } : {},
        })
      : null,
  );
  const created = useNewBotSlot(environmentId).created;
  const member =
    target === null
      ? null
      : (findMemberBot(profiles.data?.bots, target.environmentId, target.threadId) ??
        findMemberBot(created, target.environmentId, target.threadId));
  // Before the server's capabilities arrive, a member-looking thread waits too.
  const candidate =
    member === null &&
    target !== null &&
    target.threadId.startsWith(MEMBER_THREAD_PREFIX) &&
    (capabilities === undefined || supported);
  const phase = presentation?.connection.phase;
  const unreachable = phase !== undefined && phase !== "connecting" && phase !== "connected";
  const failed = profiles.data === null && profiles.error !== null;
  const unavailable =
    candidate && (capabilities === undefined ? unreachable : failed && !profiles.isPending);
  return {
    member,
    main: botRosterGroups(profiles.data?.bots ?? []).main,
    pending:
      candidate &&
      !unavailable &&
      (capabilities === undefined || profiles.isPending || profiles.data === null),
    unavailable,
    retry: capabilities === undefined ? null : profiles.refresh,
  };
}
