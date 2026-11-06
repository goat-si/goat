import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, MessageId, ThreadId } from "@goat/contracts";
import { useRef } from "react";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { readEnvironmentScope } from "../../state/session";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
} from "../../state/use-composer-drafts";
import { findSideChat, parseSideChatCommand } from "./sideChatCommand";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

const pendingSideChats = new Map<
  string,
  { environmentId: string; parentId: string; targetId: ThreadId }
>();
const startingSideChats = new Set<string>();
let stopWatching: (() => void) | undefined;
const sideChatKey = (environmentId: string, parentId: string) =>
  JSON.stringify([environmentId, parentId]);

function reconcilePendingSideChats(threads: ReadonlyArray<EnvironmentThreadShell>) {
  for (const [key, pending] of pendingSideChats) {
    if (
      threads.some(
        (thread) =>
          thread.environmentId === pending.environmentId &&
          thread.id === pending.targetId &&
          thread.sideChatOf === pending.parentId,
      )
    ) {
      pendingSideChats.delete(key);
    }
  }
  if (pendingSideChats.size === 0) {
    stopWatching?.();
    stopWatching = undefined;
  }
}

function rememberPendingSideChat(environmentId: string, parentId: string, targetId: ThreadId) {
  const key = sideChatKey(environmentId, parentId);
  pendingSideChats.set(key, { environmentId, parentId, targetId });
  stopWatching ??= appAtomRegistry.subscribe(
    environmentThreadShells.threadShellsAtom,
    reconcilePendingSideChats,
  );
  reconcilePendingSideChats(appAtomRegistry.get(environmentThreadShells.threadShellsAtom));
}

export function useSideChatCommand() {
  const fork = useAtomCommand(threadEnvironment.forkAsSideChat, { reportFailure: false });
  const create = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const open = useOpenLinkedThread();
  const busy = useRef(false);

  return async (input: {
    thread: EnvironmentThreadShell;
    threadKey: string;
    text: string;
    hasAttachmentsOrContext: boolean;
    connected: boolean;
  }): Promise<boolean> => {
    const command = parseSideChatCommand(input.text);
    if (command === null) return false;
    const { thread } = input;
    if (busy.current) return true;
    if (
      !input.connected ||
      !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)
    ) {
      Dialog.alert(
        "Side chat unavailable",
        "Connect to this environment with permission to operate threads.",
      );
      return true;
    }
    if (thread.sideChatOf != null || thread.lineage.relationshipToParent === "subagent") {
      Dialog.alert(
        "Side chat unavailable",
        "Side chats cannot start from side chats or subagents.",
      );
      return true;
    }
    if (input.hasAttachmentsOrContext) {
      Dialog.alert(
        "Side chats take text only",
        "Remove the attachments and context, then send it again.",
      );
      return true;
    }
    busy.current = true;
    let startingKey: string | undefined;
    try {
      let targetId =
        findSideChat(
          appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
          thread.environmentId,
          thread.id,
        )?.id ?? pendingSideChats.get(sideChatKey(thread.environmentId, thread.id))?.targetId;
      if (targetId === undefined) {
        const key = sideChatKey(thread.environmentId, thread.id);
        if (startingSideChats.has(key) || pendingSideChats.size + startingSideChats.size >= 128) {
          Dialog.alert(
            "Side chat unavailable",
            "Wait for the current side chat to finish starting.",
          );
          return true;
        }
        startingKey = key;
        startingSideChats.add(key);
        targetId = ThreadId.make(uuidv4());
        const title = `Side chat: ${thread.title}`;
        const forked =
          thread.latestRun === null
            ? null
            : await fork({
                environmentId: thread.environmentId,
                input: {
                  sourceThreadId: thread.id,
                  targetThreadId: targetId,
                  title,
                  creationSource: "mobile",
                },
              });
        if (forked?._tag === "Failure" && isAtomCommandInterrupted(forked)) return true;
        if (forked === null || forked._tag === "Failure") {
          const created = await create({
            environmentId: thread.environmentId,
            input: {
              threadId: targetId,
              projectId: thread.projectId,
              title,
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: "default",
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              sideChatOf: thread.id,
              creationSource: "mobile",
            },
          });
          if (created._tag === "Failure") {
            if (!isAtomCommandInterrupted(created))
              Dialog.alert("Side chat not started", String(squashAtomCommandFailure(created)));
            return true;
          }
        }
        rememberPendingSideChat(thread.environmentId, thread.id, targetId);
      }
      if (command.prompt.length > 0) {
        const result = await start({
          environmentId: thread.environmentId,
          input: {
            threadId: targetId,
            message: {
              messageId: MessageId.make(uuidv4()),
              role: "user",
              text: command.prompt,
              attachments: [],
            },
            runtimeMode: thread.runtimeMode,
            interactionMode: "default",
            creationSource: "mobile",
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result))
            Dialog.alert("Side chat not started", String(squashAtomCommandFailure(result)));
          open({ environmentId: thread.environmentId, threadId: targetId });
          return true;
        }
      }
      const current = getComposerDraftSnapshot(input.threadKey);
      if (
        current.text === input.text &&
        current.attachments.length === 0 &&
        (current.context?.records.length ?? 0) === 0
      )
        clearComposerDraftContent(input.threadKey);
      open({ environmentId: thread.environmentId, threadId: targetId });
      return true;
    } finally {
      if (startingKey !== undefined) startingSideChats.delete(startingKey);
      busy.current = false;
    }
  };
}
