import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  MessageId,
  ThreadId,
  type EnvironmentId,
} from "@goat/contracts";
import type { EnvironmentShellState } from "@goat/client-runtime/state/shell";
import * as Option from "effect/Option";
import { useRef } from "react";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { readEnvironmentScope } from "../../state/session";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
} from "../../state/use-composer-drafts";
import { findSideChat, parseSideChatCommand } from "./sideChatCommand";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

const pendingSideChats = new Map<
  string,
  {
    environmentId: EnvironmentId;
    parentId: string;
    targetId: ThreadId;
    generation: number;
    sequence: number;
  }
>();
const startingSideChats = new Set<string>();
let stopWatching: (() => void) | undefined;
const environmentWatchers = new Map<EnvironmentId, () => void>();
const sideChatKey = (environmentId: string, parentId: string) =>
  JSON.stringify([environmentId, parentId]);

function stopIdleWatchers() {
  const activeEnvironments = new Set(
    [...pendingSideChats.values()].map((pending) => pending.environmentId),
  );
  for (const [environmentId, stop] of environmentWatchers) {
    if (!activeEnvironments.has(environmentId)) {
      stop();
      environmentWatchers.delete(environmentId);
    }
  }
  if (pendingSideChats.size === 0) {
    stopWatching?.();
    stopWatching = undefined;
  }
}

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
  stopIdleWatchers();
}

function reconcileEnvironment(environmentId: EnvironmentId, state: EnvironmentShellState) {
  for (const [key, pending] of pendingSideChats) {
    if (pending.environmentId !== environmentId) continue;
    const removedAt = state.removedAt.get(pending.targetId);
    const newSnapshot = state.generation > pending.generation;
    if (newSnapshot) pending.generation = state.generation;
    if (
      (removedAt !== undefined && removedAt >= pending.sequence) ||
      (newSnapshot &&
        Option.isSome(state.snapshot) &&
        state.snapshot.value.snapshotSequence >= pending.sequence)
    )
      pendingSideChats.delete(key);
  }
  stopIdleWatchers();
}

function rememberPendingSideChat(
  environmentId: EnvironmentId,
  parentId: string,
  targetId: ThreadId,
  sequence: number,
) {
  const key = sideChatKey(environmentId, parentId);
  const stateAtom = environmentShell.stateValueAtom(environmentId);
  const state = appAtomRegistry.get(stateAtom);
  if (
    state.generation > 0 &&
    Option.isSome(state.snapshot) &&
    state.snapshot.value.snapshotSequence >= sequence &&
    !state.snapshot.value.threads.some((thread) => thread.id === targetId)
  )
    return;
  const generation = state.generation;
  pendingSideChats.set(key, { environmentId, parentId, targetId, generation, sequence });
  if (!environmentWatchers.has(environmentId)) {
    environmentWatchers.set(
      environmentId,
      appAtomRegistry.subscribe(stateAtom, (state) => reconcileEnvironment(environmentId, state)),
    );
  }
  stopWatching ??= appAtomRegistry.subscribe(
    environmentThreadShells.threadShellsAtom,
    reconcilePendingSideChats,
  );
  reconcilePendingSideChats(appAtomRegistry.get(environmentThreadShells.threadShellsAtom));
  reconcileEnvironment(environmentId, appAtomRegistry.get(stateAtom));
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
        let sequence: number;
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
          sequence = created.value.sequence;
        } else sequence = forked.value.sequence;
        rememberPendingSideChat(thread.environmentId, thread.id, targetId, sequence);
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
