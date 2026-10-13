import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadId } from "@goat/contracts";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ExternalLinkIcon, RotateCcwIcon } from "~/components/solar";
import { newMessageId, newThreadId } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { findSideChatThread } from "./sideChat.logic";
import { useSideChatStore } from "./sideChatStore";

// ChatView imports this surface through its right panel, so load it lazily to break the cycle.
const ChatView = lazy(() => import("../ChatView"));

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The side chat tab in a thread's right panel. Its thread is forked from the parent's latest
 * settled turn, so the side agent sees the conversation while nothing it says reaches the
 * parent's history, and it renders with the ordinary chat view and composer.
 */
export function SideChatSurface({
  parent,
  onOpenThread,
}: {
  readonly parent: EnvironmentThreadShell;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const environmentId = parent.environmentId;
  const parentRef = useMemo(
    () => scopeThreadRef(environmentId, parent.id),
    [environmentId, parent.id],
  );
  const parentKey = scopedThreadKey(parentRef);
  const shells = useThreadShells();
  const sideThread = useMemo(() => findSideChatThread(shells, parentRef), [shells, parentRef]);

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

  const start = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setError(null);
    const title = `Side chat: ${parent.title}`;
    try {
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
        // No settled turn to fork yet (the first one may still be running): start fresh.
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
    } finally {
      startingRef.current = false;
    }
  }, [createThread, environmentId, forkAsSideChat, parent]);

  const needsThread = sideThread === null && startedThreadId === null && error === null;
  useEffect(() => {
    if (needsThread) void start();
  }, [needsThread, start]);

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
  const startOver = useCallback(async () => {
    if (sideThreadId === null) return;
    const result = await deleteThread({ environmentId, input: { threadId: sideThreadId } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "Could not clear the side chat."));
      return;
    }
    setStartedThreadId(null);
    setError(null);
  }, [deleteThread, environmentId, sideThreadId]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-side-chat-surface>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-3">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Not added to {parent.title}
        </p>
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
