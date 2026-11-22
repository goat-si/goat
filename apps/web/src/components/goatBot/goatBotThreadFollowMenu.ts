import { chooseThreadFollow, threadFollowSupported } from "@goat/client-runtime/goatBot";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
  type ScopedThreadRef,
} from "@goat/contracts";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { channelEnvironment } from "~/state/channels";
import { readEnvironment } from "~/state/environments";
import { readEnvironmentScope } from "~/state/session";
import { ActivityIcon } from "../solar";
import { createElement } from "react";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { toastManager } from "../ui/toast";

export function webThreadFollowAvailable(thread: ScopedThreadRef) {
  const environment = readEnvironment(thread.environmentId);
  return (
    environment?.connection.phase === "connected" &&
    threadFollowSupported(
      thread,
      environment.serverConfig?.environment.capabilities?.goatBotThreadFollows,
    ) &&
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)
  );
}

export async function openWebThreadFollowMenu(
  thread: ScopedThreadRef,
  action: "follow" | "stop",
  position?: { x: number; y: number },
) {
  const api = readLocalApi();
  if (!api || !webThreadFollowAvailable(thread)) return;
  await chooseThreadFollow(
    appAtomRegistry,
    channelEnvironment,
    thread,
    action,
    (title, choices) =>
      api.contextMenu
        .show([{ id: "", label: title, header: true, disabled: true }, ...choices], position)
        .catch(() => null),
    (title) => toastManager.add({ type: "info", title }),
  );
}

export function handleWebThreadFollowAction(
  thread: ScopedThreadRef,
  action: string,
  position: { x: number; y: number },
) {
  if (action === "bot-follow") return openWebThreadFollowMenu(thread, "follow", position);
  if (action === "bot-stop-following") return openWebThreadFollowMenu(thread, "stop", position);
}

export function webThreadFollowPaletteItems(
  activeThread: { environmentId: EnvironmentId; id: ThreadId } | null | undefined,
): CommandPaletteActionItem[] {
  if (!activeThread) return [];
  const target = { environmentId: activeThread.environmentId, threadId: activeThread.id };
  if (!webThreadFollowAvailable(target)) return [];
  return [
    {
      kind: "action" as const,
      value: "action:bot-follow-thread",
      title: "Ask a bot to follow…",
      searchTerms: ["ask a bot to follow", "watch thread"],
      icon: createElement(ActivityIcon, { className: ITEM_ICON_CLASS }),
      run: () => openWebThreadFollowMenu(target, "follow"),
    },
    {
      kind: "action",
      value: "action:bot-stop-following-thread",
      title: "Stop following",
      searchTerms: ["stop following", "unfollow thread"],
      icon: createElement(ActivityIcon, { className: ITEM_ICON_CLASS }),
      run: () => openWebThreadFollowMenu(target, "stop"),
    },
  ];
}
