import { findMemberBot } from "@goat/client-runtime/goatBot";
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
  readonly pending: boolean;
  readonly unavailable: boolean;
  readonly retry: () => void;
} {
  const environmentId = target?.environmentId ?? null;
  const presentation = useEnvironment(environmentId);
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  const supported = environmentId !== null && capabilities?.goatBotMembers === true;
  const profiles = useEnvironmentQuery(
    supported
      ? channelEnvironment.listBots({ environmentId, input: { includeDeleted: true } })
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
    pending:
      candidate &&
      !unavailable &&
      (capabilities === undefined || profiles.isPending || profiles.data === null),
    unavailable,
    retry: profiles.refresh,
  };
}
