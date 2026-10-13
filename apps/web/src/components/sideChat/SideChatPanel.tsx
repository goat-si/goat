import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { threadRuntimeIsActive } from "@goat/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadId } from "@goat/contracts";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ExternalLinkIcon,
  MessagesSquareIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "~/components/solar";
import { newMessageId, newThreadId } from "~/lib/utils";
import { useThreadShells, useThreadVisibleTurnItems } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { findSideChatThread, sideChatRows } from "./sideChat.logic";
import { useSideChatStore } from "./sideChatStore";

/** How close to the bottom still counts as following new output. */
const FOLLOW_THRESHOLD_PX = 48;

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * A side chat beside its parent thread: a hidden thread forked from the parent's latest
 * settled turn, so the side agent sees the conversation while nothing it says reaches the
 * parent's history. It runs on the parent's provider, model, and workspace.
 */
export function SideChatPanel({
  parent,
  cwd,
  shortcutLabel,
  onOpenThread,
  onClose,
}: {
  readonly parent: EnvironmentThreadShell;
  readonly cwd: string | undefined;
  readonly shortcutLabel: string | null;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
  readonly onClose: () => void;
}) {
  const environmentId = parent.environmentId;
  const parentRef = useMemo(
    () => scopeThreadRef(environmentId, parent.id),
    [environmentId, parent.id],
  );
  const parentKey = scopedThreadKey(parentRef);
  const shells = useThreadShells();
  const sideThread = useMemo(() => findSideChatThread(shells, parentRef), [shells, parentRef]);
  // A side chat this panel started whose shell has not arrived yet.
  const [startedThreadId, setStartedThreadId] = useState<ThreadId | null>(null);
  const sideThreadId = sideThread?.id ?? startedThreadId;
  const sideRef = useMemo(
    () => (sideThreadId === null ? null : scopeThreadRef(environmentId, sideThreadId)),
    [environmentId, sideThreadId],
  );
  const rows = sideChatRows(useThreadVisibleTurnItems(sideThread === null ? null : sideRef));

  const forkAsSideChat = useOrchestrationCommand(threadEnvironment.forkAsSideChat, {
    reportFailure: false,
  });
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const interruptThreadTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const deleteThread = useOrchestrationCommand(threadEnvironment.delete, { reportFailure: false });

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const working = sending || threadRuntimeIsActive(sideThread?.runtime);
  const needsAttention =
    sideThread !== null && (sideThread.hasPendingApprovals || sideThread.hasPendingUserInput);
  const runtimeError = sideThread?.runtime?.lastError ?? null;

  const ensureSideThread = useCallback(async (): Promise<ThreadId> => {
    if (sideThreadId !== null) return sideThreadId;
    const title = `Side chat: ${parent.title}`;
    if (parent.latestRun !== null) {
      const targetThreadId = newThreadId();
      const forked = await forkAsSideChat({
        environmentId,
        input: { sourceThreadId: parent.id, targetThreadId, title },
      });
      if (forked._tag === "Success") return targetThreadId;
      if (isAtomCommandInterrupted(forked)) throw new Error("The side chat was not started.");
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
      throw new Error(failureMessage(created, "Could not start the side chat."));
    }
    return threadId;
  }, [createThread, environmentId, forkAsSideChat, parent, sideThreadId]);

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (prompt === "" || sendingRef.current) return;
      sendingRef.current = true;
      setSending(true);
      setError(null);
      setPendingText(prompt);
      setDraft("");
      try {
        const threadId = await ensureSideThread();
        setStartedThreadId(threadId);
        const started = await startThreadTurn({
          environmentId,
          input: {
            threadId,
            message: { messageId: newMessageId(), role: "user", text: prompt, attachments: [] },
            runtimeMode: sideThread?.runtimeMode ?? parent.runtimeMode,
            interactionMode: "default",
          },
        });
        if (started._tag === "Failure") {
          throw new Error(failureMessage(started, "Could not send the side question."));
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not send the side question.");
        setDraft((current) => (current === "" ? prompt : current));
      } finally {
        sendingRef.current = false;
        setSending(false);
        setPendingText(null);
      }
    },
    [environmentId, ensureSideThread, parent.runtimeMode, sideThread, startThreadTurn],
  );

  // `/side <question>` opens the panel with the question already asked.
  const pendingPrompt = useSideChatStore((state) => state.panels[parentKey]?.pendingPrompt ?? null);
  useEffect(() => {
    if (pendingPrompt === null || sendingRef.current) return;
    const prompt = useSideChatStore.getState().takePendingPrompt(parentKey);
    if (prompt !== null) void send(prompt);
  }, [parentKey, pendingPrompt, send]);

  // The panel remounts per parent thread, so this runs once each time it opens.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const stop = useCallback(async () => {
    if (sideThread === null) return;
    const result = await interruptThreadTurn({
      environmentId,
      input: { threadId: sideThread.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "Could not stop the side chat."));
    }
  }, [environmentId, interruptThreadTurn, sideThread]);

  // Side chats are disposable: starting over discards this one.
  const startOver = useCallback(async () => {
    if (sideThreadId === null) return;
    const result = await deleteThread({ environmentId, input: { threadId: sideThreadId } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "Could not clear the side chat."));
      return;
    }
    setStartedThreadId(null);
    setError(null);
    textareaRef.current?.focus();
  }, [deleteThread, environmentId, sideThreadId]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send(draft);
      }
    },
    [draft, onClose, send],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const lastRow = rows.at(-1);
  const showPending =
    pendingText !== null && !(lastRow?.kind === "user" && lastRow.text.trim() === pendingText);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null || !followingRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [rows.length, lastRow?.text, showPending, working]);

  return (
    <aside
      aria-label="Side chat"
      className="flex min-h-0 w-[min(24rem,42%)] shrink-0 flex-col border-r border-border bg-background max-sm:absolute max-sm:inset-0 max-sm:z-30 max-sm:w-full"
      data-side-chat-panel
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
        <MessagesSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">Side chat</h2>
        </div>
        {sideThread !== null ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Start a new side chat"
                    disabled={working}
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
                    aria-label="Open side chat as a thread"
                    onClick={() => onOpenThread(scopeThreadRef(environmentId, sideThread.id))}
                  />
                }
              >
                <ExternalLinkIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Open as a full thread</TooltipPopup>
            </Tooltip>
          </>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close side chat"
                onClick={onClose}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Close side chat{shortcutLabel ? ` (${shortcutLabel})` : ""}
          </TooltipPopup>
        </Tooltip>
      </div>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followingRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {rows.length === 0 && !showPending ? (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">
            Ask about this thread without adding to it. The side agent sees the conversation so far
            and uses the same model.
          </p>
        ) : null}
        <ol className="flex flex-col gap-3">
          {rows.map((row) =>
            row.kind === "user" ? (
              <li key={row.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-secondary px-3 py-2 text-sm break-words whitespace-pre-wrap text-secondary-foreground">
                  {row.text}
                </div>
              </li>
            ) : (
              <li key={row.id} className="min-w-0 text-sm">
                <ChatMarkdown
                  text={row.text}
                  cwd={cwd}
                  threadRef={sideRef ?? undefined}
                  isStreaming={row.streaming}
                />
              </li>
            ),
          )}
          {showPending ? (
            <li className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl bg-secondary px-3 py-2 text-sm break-words whitespace-pre-wrap text-secondary-foreground opacity-70">
                {pendingText}
              </div>
            </li>
          ) : null}
          {working && lastRow?.kind !== "assistant" ? (
            <li className="text-xs text-muted-foreground" role="status">
              Working…
            </li>
          ) : null}
        </ol>
      </div>

      {needsAttention && sideThread !== null ? (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">The side chat is waiting for your answer.</span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => onOpenThread(scopeThreadRef(environmentId, sideThread.id))}
          >
            Open
          </Button>
        </div>
      ) : null}
      {(error ?? runtimeError) ? (
        <p role="alert" className="mx-3 mb-2 text-xs text-destructive-foreground">
          {error ?? runtimeError}
        </p>
      ) : null}

      <div className="shrink-0 border-t border-border p-3">
        <Textarea
          ref={textareaRef}
          size="sm"
          aria-label="Side question"
          placeholder="Ask a side question…"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          {working && sideThread !== null ? (
            <Button variant="outline" size="xs" onClick={() => void stop()}>
              <SquareIcon />
              Stop
            </Button>
          ) : null}
          <Button
            size="xs"
            disabled={draft.trim() === "" || sending}
            onClick={() => void send(draft)}
          >
            Ask
          </Button>
        </div>
      </div>
    </aside>
  );
}
