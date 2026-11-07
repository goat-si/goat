import { botRosterGroups, findMemberBot } from "@goat/client-runtime/goatBot";
import type { BotProfile, EnvironmentId, ThreadId } from "@goat/contracts";

import { useEnvironment } from "~/state/environments";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";

// Member conversations get stable ids with this prefix (apps/server/src/channels/channelIds.ts,
// memberBotLaunchIdsFor). Used only to wait for the bot list, never to decide a thread is a bot.
const MEMBER_THREAD_PREFIX = "channel-member-bot:";

/**
 * The member bot whose conversation this thread is, deleted ones included, so the thread renders
 * as that bot and never as a coding thread. Reads the roster's own cached list. A thread that may
 * be a member's is `pending` until that list answers and `unavailable` if it cannot be read.
 */
export function useGoatBotMemberAt(
  target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
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
  // The roster's own list (useBotRoster): it also names the main chat where profiles exist.
  const profiles = useEnvironmentQuery(
    environmentId !== null && (supported || capabilities?.goatBotProfiles === true)
      ? channelEnvironment.listBots({
          environmentId,
          input: supported ? { includeDeleted: true } : {},
        })
      : null,
  );
  const member =
    target === null
      ? null
      : findMemberBot(profiles.data?.bots, target.environmentId, target.threadId);
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
