import { findMemberBot } from "@goat/client-runtime/goatBot";
import type { BotProfile, EnvironmentId, ThreadId } from "@goat/contracts";

import { useEnvironment } from "~/state/environments";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";

/**
 * The member bot whose conversation this thread is, deleted ones included, so the thread renders
 * as that bot and never as a coding thread. Reads the roster's own cached list.
 */
export function useGoatBotMemberAt(
  target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
): BotProfile | null {
  const environmentId = target?.environmentId ?? null;
  const presentation = useEnvironment(environmentId);
  const supported =
    environmentId !== null &&
    presentation?.serverConfig?.environment.capabilities.goatBotMembers === true;
  const profiles = useEnvironmentQuery(
    supported
      ? channelEnvironment.listBots({ environmentId, input: { includeDeleted: true } })
      : null,
  );
  return target === null
    ? null
    : findMemberBot(profiles.data?.bots, target.environmentId, target.threadId);
}
