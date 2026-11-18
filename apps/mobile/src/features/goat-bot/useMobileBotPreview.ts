import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import {
  buildGoatBotTimeline,
  goatBotConversationPreview,
  goatBotItemReaders,
} from "@goat/client-runtime/goatBot";
import { channelEnvironment } from "../../state/channels";
import { useThreadShell } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useComputerReadable, useKeptPerComputer } from "./useKeptPerComputer";

/**
 * A bot conversation's newest message and whether it is unread; null reads nothing. A thread keeps
 * its messages after access is refused, and the saved bot still names a removed computer, so none
 * shows once this phone may no longer read that computer.
 */
export function useMobileBotPreview(
  botRef: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
) {
  const ref = botRef ? scopeThreadRef(botRef.environmentId, botRef.threadId) : null;
  const presentation = useAtomValue(environmentPresentations.presentationsAtom).get(
    botRef?.environmentId ?? ("" as EnvironmentId),
  );
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  const connected = presentation?.connection.phase === "connected";
  // The bot list the roster reads, read here too: the roster can show another computer, and a
  // refusal of this one must stay known once it goes offline.
  const list = useEnvironmentQuery(
    botRef !== null && connected && capabilities?.goatBotProfiles === true
      ? channelEnvironment.listBots({
          environmentId: botRef.environmentId,
          input: capabilities.goatBotMembers === true ? { includeDeleted: true } : {},
        })
      : null,
  );
  useKeptPerComputer("bots", botRef?.environmentId ?? null, list, !connected);
  const readable = useComputerReadable(botRef?.environmentId ?? null);
  const shell = useThreadShell(ref);
  const items = useThreadVisibleTurnItems({
    environmentId: botRef?.environmentId ?? null,
    threadId: botRef?.threadId ?? null,
  });
  const rows = buildGoatBotTimeline({
    visibleTurnItems: items,
    pendingInputs: [],
    readers: goatBotItemReaders,
    // The bot's own conversation, read as its main chat.
    taskId: null,
    // As the chat reads it: an answer is what the server recorded.
    answerReferences: true,
  });
  if (!readable) return null;
  return goatBotConversationPreview({ rows, lastVisitedAt: shell?.lastVisitedAt, active: false });
}
