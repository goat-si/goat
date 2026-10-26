import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadId } from "@goat/contracts";
import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from "react";

import { ExternalLinkIcon, RotateCcwIcon } from "~/components/solar";
import { newMessageId, newThreadId } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  findSideChatThread,
  sideChatParentStatus,
  type SideChatParentTone,
} from "./sideChat.logic";
import { useSideChatStore } from "./sideChatStore";

// ChatView imports this surface through its right panel, so load it lazily to break the cycle.
const ChatView = lazy(() => import("../ChatView"));

const PARENT_TONE_CLASSES: Record<SideChatParentTone, { text: string; dot: string }> = {
  active: { text: "text-sky-600 dark:text-sky-300/80", dot: "bg-sky-500 dark:bg-sky-300/80" },
  attention: {
    text: "text-amber-600 dark:text-amber-300/90",
    dot: "bg-amber-500 dark:bg-amber-300/90",
  },
  idle: { text: "text-muted-foreground", dot: "bg-muted-foreground/60" },
  error: { text: "text-red-600 dark:text-red-300/90", dot: "bg-red-500 dark:bg-red-300/90" },
};

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The side chat tab in a thread's right panel. Its thread is forked from the parent's latest
 * completed turn when there is one, and the server adds the parent's live state to every side
 * prompt, so the side agent follows the parent while nothing it says reaches the parent's history.
 */
export function SideChatSurface({
  parent,
  onOpenThread,
}: {
  readonly parent: EnvironmentThreadShell;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const environmentId = parent.environmentId;
  const parentRef = scopeThreadRef(environmentId, parent.id);
  const parentKey = scopedThreadKey(parentRef);
  const shells = useThreadShells();
  const sideThread = findSideChatThread(shells, parentRef);

  const forkAsSideChat = useOrchestrationCommand(threadEnvironment.forkAsSideChat, {
    reportFailure: false,
  });
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const deleteThread = useOrchestrationCommand(threadEnvironment.delete, { reportFailure: false });

  // A side chat this tab started whose shell has not arrived yet.
  const [startedThreadId, setStartedThreadId] = useState<ThreadId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startingRef = useRef(false);

  const createSideChat = async () => {
    const title = `Side chat: ${parent.title}`;
    if (parent.latestRun !== null) {
      const targetThreadId = newThreadId();
      const forked = await forkAsSideChat({
        environmentId,
        input: { sourceThreadId: parent.id, targetThreadId, title },
      });
      if (forked._tag === "Success") {
        setStartedThreadId(targetThreadId);
        return;
      }
      if (isAtomCommandInterrupted(forked)) return;
      // No completed turn to fork yet: start empty and rely on the parent's live state, which
      // the server sends with every side prompt.
    }
    const threadId = newThreadId();
    const created = await createThread({
      environmentId,
      input: {
        threadId,
        projectId: parent.projectId,
        title,
        modelSelection: parent.modelSelection,
        runtimeMode: parent.runtimeMode,
        interactionMode: "default",
        branch: parent.branch,
        worktreePath: parent.worktreePath,
        sideChatOf: parent.id,
      },
    });
    if (created._tag === "Failure") {
      if (!isAtomCommandInterrupted(created)) {
        setError(failureMessage(created, "Could not start the side chat."));
      }
      return;
    }
    setStartedThreadId(threadId);
  };
  const start = useEffectEvent(() => {
    if (startingRef.current) return;
    startingRef.current = true;
    setError(null);
    void createSideChat().finally(() => {
      startingRef.current = false;
    });
  });

  const needsThread = sideThread === null && startedThreadId === null && error === null;
  useEffect(() => {
    if (needsThread) start();
  }, [needsThread]);

  // `/side <question>` asks once the side chat exists.
  const pendingPrompt = useSideChatStore((state) => state.pendingPrompts[parentKey] ?? null);
  const sideThreadId = sideThread?.id ?? null;
  useEffect(() => {
    if (pendingPrompt === null || sideThreadId === null) return;
    const prompt = useSideChatStore.getState().takePendingPrompt(parentKey);
    if (prompt === null) return;
    void startThreadTurn({
      environmentId,
      input: {
        threadId: sideThreadId,
        message: { messageId: newMessageId(), role: "user", text: prompt, attachments: [] },
        runtimeMode: parent.runtimeMode,
        interactionMode: "default",
      },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setError(failureMessage(result, "Could not send the side question."));
      }
    });
  }, [environmentId, parent.runtimeMode, parentKey, pendingPrompt, sideThreadId, startThreadTurn]);

  // Side chats are disposable: starting over discards this one and forks the thread again.
  const startOver = async () => {
    if (sideThreadId === null) return;
    const result = await deleteThread({ environmentId, input: { threadId: sideThreadId } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "Could not clear the side chat."));
      return;
    }
    setStartedThreadId(null);
    setError(null);
  };

  const parentStatus = sideChatParentStatus(parent);
  const parentTone = PARENT_TONE_CLASSES[parentStatus.tone];

  return (
    <div className="flex h-full min-h-0 flex-col" data-side-chat-surface>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <p className="flex min-w-0 flex-1 items-baseline gap-1 text-xs text-muted-foreground" />
            }
          >
            <span className="shrink-0">Side chat of</span>
            <span className="min-w-0 truncate font-medium text-foreground">{parent.title}</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Sees the main thread's latest messages and status. Nothing said here is added to it.
          </TooltipPopup>
        </Tooltip>
        <span
          role="status"
          aria-label={`Main thread: ${parentStatus.label}`}
          className={`inline-flex shrink-0 items-center gap-1 text-2xs ${parentTone.text}`}
          data-side-chat-parent-status={parentStatus.tone}
        >
          <span aria-hidden className={`size-1.5 rounded-full ${parentTone.dot}`} />
          {parentStatus.label}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Start a new side chat"
                disabled={sideThread === null}
                onClick={() => void startOver()}
              />
            }
          >
            <RotateCcwIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Start a new side chat</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Open side chat as a full thread"
                disabled={sideThread === null}
                onClick={() => {
                  if (sideThread !== null)
                    onOpenThread(scopeThreadRef(environmentId, sideThread.id));
                }}
              />
            }
          >
            <ExternalLinkIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Open as a full thread</TooltipPopup>
        </Tooltip>
      </div>
      <div className="relative flex min-h-0 flex-1">
        {sideThread !== null ? (
          <Suspense fallback={null}>
            <ChatView
              key={sideThread.id}
              environmentId={environmentId}
              threadId={sideThread.id}
              routeKind="server"
              reserveTitleBarControlInset={false}
              embedded
            />
          </Suspense>
        ) : error !== null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
            <Button variant="outline" size="xs" onClick={() => setError(null)}>
              Try again
            </Button>
          </div>
        ) : (
          <p role="status" className="m-auto text-sm text-muted-foreground">
            Starting side chat…
          </p>
        )}
      </div>
    </div>
  );
}
