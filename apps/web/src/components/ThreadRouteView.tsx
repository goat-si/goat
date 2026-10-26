import { scopedThreadKey } from "@goat/client-runtime/environment";
import { shellSyncMessage } from "@goat/client-runtime/state/presentation";
import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";
import { useAtomRefresh } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import ChatView from "./ChatView";
import { GoatBotThreadView } from "./goatBot/GoatBotThreadView";
import { BackgroundThreadContext } from "./chat/backgroundThread";
import { resolveDraftPromotionNavigationTarget, threadHasStarted } from "./ChatView.logic";
import { waitForDraftHeroTransition } from "./chat/draftHeroTransition";
import { SidebarInset } from "./ui/sidebar";
import { Button } from "./ui/button";
import { useEnvironmentShellSync } from "../state/presentation";
import {
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { isGoatBotThread } from "../globalAgentRoute";
import { useGlobalAgentStore } from "../globalAgentStore";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { useEnvironmentThreadRefs, useThreadRefs, useQuietThreadShell } from "../state/entities";
import { environmentShell, useEnvironmentShellStatus } from "../state/shell";
import { useEnvironmentThread } from "../state/threads";
import {
  buildThreadRouteParams,
  isThreadRouteSnapshotAuthoritative,
  resolveThreadRouteRenderState,
  type ThreadRouteTarget,
} from "../threadRoutes";

/**
 * Render in the shared layout to retain ChatView across route swaps; plain server threads remain unkeyed.
 * `background` keeps the thread mounted, inert and in place under Settings or Usage.
 */
export function ThreadRouteView({
  target,
  background = false,
}: {
  target: ThreadRouteTarget;
  background?: boolean;
}) {
  const navigate = useNavigate();
  const goatBotRef = useGlobalAgentStore((state) => state.botRef);
  // GOAT Bot's thread always shows as the bot, even while missing or unsupported, so the
  // coding composer never appears on it and its own notice replaces the redirect below.
  const goatBotTarget =
    target.kind === "server" &&
    isGoatBotThread(
      { environmentId: target.threadRef.environmentId, id: target.threadRef.threadId },
      goatBotRef,
    );
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const threadRefs = useThreadRefs();
  // Promotion can begin before the server creates the reserved thread.
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef: ScopedThreadRef | null =
    target.kind === "server" ? target.threadRef : inferredThreadRef;
  const serverThread = useQuietThreadShell(serverThreadRef);
  const sync = useEnvironmentShellSync(serverThreadRef?.environmentId ?? null);
  const syncMessage = shellSyncMessage(sync);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(
    target.kind === "draft" ? serverThreadRef : null,
  );
  const canonicalThreadRef =
    target.kind === "draft"
      ? resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread,
          backgroundSubmissionPending,
        })
      : null;

  const shellStatus = useEnvironmentShellStatus(serverThreadRef?.environmentId ?? null);
  const serverThreadShell = serverThread;
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shellStatus);
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  const promotedDraftId = useComposerDraftStore((store) =>
    target.kind === "server" ? store.getDraftIdByRef(target.threadRef) : null,
  );
  // Latch the key through promotion because the draft record disappears after the route swap.
  const [chatViewKey, setChatViewKey] = useState<{ threadKey: string; key: string } | null>(null);
  const serverThreadKey = target.kind === "server" ? scopedThreadKey(target.threadRef) : null;
  const nextChatViewKey =
    serverThreadKey === null
      ? null
      : chatViewKey?.threadKey === serverThreadKey
        ? chatViewKey
        : promotedDraftId
          ? { threadKey: serverThreadKey, key: promotedDraftId }
          : null;
  if (nextChatViewKey !== chatViewKey) {
    setChatViewKey(nextChatViewKey);
  }
  const environmentHasDraftThreads = useComposerDraftStore((store) =>
    serverThreadRef ? store.hasDraftThreadsInEnvironment(serverThreadRef.environmentId) : false,
  );
  // Until the shell lists the thread, its own load (HTTP, then the socket)
  // decides whether it exists. Read only then: once listed, ChatView keeps
  // this stream open and its updates need not re-render the route.
  const unlistedThreadRef =
    target.kind === "server" && serverThreadShell === null && draftThread === null
      ? target.threadRef
      : null;
  const unlistedThreadDetail = useEnvironmentThread(
    unlistedThreadRef?.environmentId ?? null,
    unlistedThreadRef?.threadId ?? null,
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: serverThreadShell !== null,
    serverThreadDeleted: serverThreadShell?.deletedAt != null,
    unlistedThreadDetail,
    draftThreadExists: draftThread !== null,
  });
  const serverThreadStarted = threadHasStarted(serverThreadShell);
  const environmentHasAnyThreads = environmentThreadRefs.length > 0 || environmentHasDraftThreads;

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef || background) {
      return;
    }
    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [background, canonicalThreadRef, navigate]);

  useEffect(() => {
    if (background || target.kind !== "draft" || draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [background, canonicalThreadRef, draftSession, navigate, target.kind]);

  useEffect(() => {
    if (target.kind !== "server" || !bootstrapComplete || goatBotTarget) {
      return;
    }
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
      if (environmentHasAnyThreads && !background) {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [
    background,
    bootstrapComplete,
    environmentHasAnyThreads,
    goatBotTarget,
    navigate,
    renderState,
    target,
  ]);

  useEffect(() => {
    if (target.kind !== "server" || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(target.threadRef);
  }, [draftThread, serverThreadStarted, target]);

  let view: React.ReactNode = null;
  if (target.kind === "draft") {
    if (draftSession) {
      view = (
        <ChatView
          key={target.draftId}
          draftId={target.draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
          forceExpandedMobileComposer
        />
      );
    }
  } else if (goatBotTarget) {
    view = (
      <GoatBotThreadView
        environmentId={target.threadRef.environmentId}
        threadId={target.threadRef.threadId}
      />
    );
  } else if (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null)) {
    view = (
      <ChatView
        key={nextChatViewKey?.key}
        environmentId={target.threadRef.environmentId}
        threadId={target.threadRef.threadId}
        routeKind="server"
      />
    );
  }

  return (
    <SidebarInset
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
      inert={background}
    >
      {target.kind === "server" && syncMessage !== null && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-warning/30 bg-warning-surface px-4 py-2 text-sm text-warning-foreground"
        >
          <span>{syncMessage}</span>
          {(sync === "error" || sync === "stale") && (
            <RetryShellSyncButton environmentId={target.threadRef.environmentId} />
          )}
        </div>
      )}
      <BackgroundThreadContext value={background}>{view}</BackgroundThreadContext>
    </SidebarInset>
  );
}

// Separate component so the route view never subscribes to the shell state, which changes on
// every streamed event.
function RetryShellSyncButton({ environmentId }: { environmentId: EnvironmentId }) {
  const refresh = useAtomRefresh(environmentShell.stateAtom(environmentId));
  return (
    <Button variant="outline" size="sm" onClick={refresh}>
      Retry sync
    </Button>
  );
}
