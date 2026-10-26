import { RefreshIcon } from "~/components/ui/refresh-icon";
import { scopeProjectRef, scopeThreadRef } from "@goat/client-runtime/environment";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../env";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { useComposerDraftStore } from "../composerDraftStore";
import { useGlobalAgentStore } from "../globalAgentStore";
import { confirmPromotedGlobalAgent, resolveGlobalAgent } from "../globalAgentResolver";
import type { GlobalAgentDraftState } from "../globalAgentResolver";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  readThreadShell,
  readProject,
  useAllEnvironmentShellsBootstrapped,
  useEnvironmentShellsBootstrapped,
  usePendingEnvironmentShellIds,
  useProjects,
  useThreadShell,
  useThreadShells,
  waitForThreadShell,
} from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }

  return <IndexDraftLanding />;
}

/**
 * "/" opens the global agent: one persistent projectless thread. Without a
 * machine that offers projectless threads, it falls back to a draft in the
 * most recently active project, and to the add-project hero without one.
 */
function IndexDraftLanding() {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const globalAgentRef = useGlobalAgentStore((state) => state.ref);
  const refEnvironmentBootstrapped = useEnvironmentShellsBootstrapped(
    globalAgentRef?.environmentId ?? null,
  );
  const setGlobalAgentRef = useGlobalAgentStore((state) => state.setRef);
  const globalThreadRef =
    globalAgentRef === null
      ? null
      : scopeThreadRef(globalAgentRef.environmentId, globalAgentRef.threadId);
  const globalThreadShell = useThreadShell(globalThreadRef);
  const globalDraftState = useComposerDraftStore((store): GlobalAgentDraftState => {
    const session = globalAgentRef === null ? null : store.getDraftSession(globalAgentRef.draftId);
    if (session === null) return "none";
    return session.promotedTo != null ? "promoted" : "unpromoted";
  });
  const router = useRouter();
  // Read at effect time; this page can stay mounted while the router is already navigating away.
  const isStillOnIndex = useEffectEvent(() => router.state.location.pathname === "/");
  // One start per attempt; a retry request opens the next attempt, and a failed or
  // projectless run releases it (null) so a later input change can start again.
  const startedAttemptRef = useRef<number | null>(null);
  // Unmount only. Dependency changes must not cancel or restart an in-flight run:
  // creating the scratch project changes `projects`, and a restart would create twice.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Set when the fallback finds no project (also after a confirm wait), so the hero shows.
  const [fallbackReady, setFallbackReady] = useState(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });
  const attempt = startState.retryRequest;

  const mostRecentProject = bootstrapped
    ? (sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null)
    : null;
  // Read at the end of an async run, after a confirm wait during which a project may arrive.
  const readMostRecentProject = useEffectEvent(() => mostRecentProject);

  // A saved global agent keeps its machine. Without one: the primary machine,
  // then the only machine offering projectless threads.
  const preferredScratchEnvironmentId =
    globalAgentRef !== null
      ? scratchEnvironmentId(globalAgentRef.environmentId)
      : (scratchEnvironmentId(primaryEnvironmentId ?? null) ?? scratchEnvironmentId(null));
  // Read after a confirm wait, like readMostRecentProject.
  const readScratchEnvironmentId = useEffectEvent(() => preferredScratchEnvironmentId);
  const resolution = resolveGlobalAgent({
    bootstrapped,
    refEnvironmentBootstrapped,
    ref: globalAgentRef,
    threadShell: globalThreadShell,
    draftState: globalDraftState,
    refEnvironmentKnown:
      globalAgentRef !== null &&
      environments.some((entry) => entry.environmentId === globalAgentRef.environmentId),
    scratchEnvironmentId: preferredScratchEnvironmentId,
  });
  // Primitive effect inputs: the resolution object is rebuilt every render.
  const resolutionKind = resolution.kind;
  const targetEnvironmentId =
    resolution.kind === "open-thread" ||
    resolution.kind === "create" ||
    resolution.kind === "confirm-thread"
      ? resolution.environmentId
      : null;
  const targetThreadId =
    resolution.kind === "open-thread" || resolution.kind === "confirm-thread"
      ? resolution.threadId
      : null;
  const targetDraftId = resolution.kind === "open-draft" ? resolution.draftId : null;

  useEffect(() => {
    if (startedAttemptRef.current === attempt || resolutionKind === "wait" || !isStillOnIndex())
      return;
    startedAttemptRef.current = attempt;
    const fail = () => {
      if (!mountedRef.current || !isStillOnIndex()) return;
      startedAttemptRef.current = null;
      setStartState((state) => ({ ...state, failed: true }));
    };
    const openThread = (environmentId: EnvironmentId, threadId: ThreadId) =>
      navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
        replace: true,
      });
    const createGlobalAgent = async (environmentId: EnvironmentId) => {
      const project = await openScratchProject(environmentId);
      // handleNewThread reads the route when called; never start it from a page the user moved to.
      if (!mountedRef.current || !isStillOnIndex()) return;
      if (project === null) return fail();
      const created = await handleNewThread(scopeProjectRef(environmentId, project.id), {
        replace: true,
      });
      if (created === null) return fail();
      // No mount check here: a successful handleNewThread navigates to the new
      // draft itself, so "/" is normally already unmounted at this point.
      setGlobalAgentRef({ environmentId, threadId: created.threadId, draftId: created.draftId });
    };
    // Today's behavior: a draft in the most recent project, or the hero (rendered below).
    const startFallback = async (project: typeof mostRecentProject) => {
      if (!mountedRef.current || !isStillOnIndex()) return;
      if (project === null) {
        // Release so a project arriving later re-runs this effect (mostRecentProject is a
        // dependency), and show the hero meanwhile. fallbackReady is not a dependency,
        // so setting it cannot loop.
        startedAttemptRef.current = null;
        setFallbackReady(true);
        return;
      }
      const projectRef = scopeProjectRef(project.environmentId, project.id);
      const retry = () => {
        if (!mountedRef.current || !isStillOnIndex()) return;
        startedAttemptRef.current = null;
        setStartState((state) => ({ ...state, retryRequest: state.retryRequest + 1 }));
      };
      if (readProject(projectRef) === null) {
        retry();
        return;
      }
      const opened = await handleNewThread(projectRef, { replace: true });
      if (opened === null) retry();
    };
    const run = async (): Promise<unknown> => {
      if (
        resolutionKind === "open-thread" &&
        targetEnvironmentId !== null &&
        targetThreadId !== null
      ) {
        return openThread(targetEnvironmentId, targetThreadId);
      }
      if (resolutionKind === "open-draft" && targetDraftId !== null) {
        return navigate({
          to: "/draft/$draftId",
          params: { draftId: targetDraftId },
          replace: true,
        });
      }
      if (resolutionKind === "create" && targetEnvironmentId !== null) {
        return createGlobalAgent(targetEnvironmentId);
      }
      if (
        resolutionKind === "confirm-thread" &&
        targetEnvironmentId !== null &&
        targetThreadId !== null
      ) {
        const confirmRef = scopeThreadRef(targetEnvironmentId, targetThreadId);
        const settled = await confirmPromotedGlobalAgent({
          environmentId: targetEnvironmentId,
          threadId: targetThreadId,
          readScratchEnvironmentId: () => readScratchEnvironmentId(),
          waitForShell: () => waitForThreadShell(confirmRef, 5_000),
          readShell: () => readThreadShell(confirmRef),
        });
        // The wait can take seconds; never act after "/" has unmounted.
        if (!mountedRef.current || !isStillOnIndex()) return undefined;
        if (settled.kind === "open-thread") {
          return openThread(settled.environmentId, settled.threadId);
        }
        if (settled.kind === "create") return createGlobalAgent(settled.environmentId);
        // The live project: the confirm wait may have outlasted this run's inputs.
        return startFallback(readMostRecentProject());
      }
      return startFallback(mostRecentProject);
    };
    void run().catch(fail);
  }, [
    handleNewThread,
    mostRecentProject,
    navigate,
    openScratchProject,
    resolutionKind,
    setGlobalAgentRef,
    attempt,
    targetDraftId,
    targetEnvironmentId,
    targetThreadId,
  ]);

  if (resolutionKind === "wait") return <IndexWaitingState />;
  if (startState.failed) {
    return (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({ failed: false, retryRequest: state.retryRequest + 1 }));
        }}
      />
    );
  }
  // The hero belongs to the fallback only: once creation starts it would offer a second,
  // competing "start without a project". A confirm wait that ended in the fallback keeps
  // resolutionKind "confirm-thread", hence fallbackReady.
  if (
    (resolutionKind === "fallback" || (resolutionKind === "confirm-thread" && fallbackReady)) &&
    mostRecentProject === null
  ) {
    // First-run routing to the welcome wizard happens in FirstRunGate at the
    // root, before this route ever renders.
    return <NoProjectsHero />;
  }
  return null;
}

function IndexWaitingState() {
  const pendingIds = usePendingEnvironmentShellIds();
  const { presentationById } = useEnvironments();
  const pendingLabels = pendingIds?.map(
    (environmentId) => presentationById.get(environmentId)?.entry.target.label ?? environmentId,
  );

  return (
    <SidebarInset>
      <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-hidden overscroll-y-none bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border" />
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Waiting for your machines</EmptyTitle>
            {pendingLabels?.length ? (
              <EmptyDescription>Still loading: {pendingLabels.join(", ")}.</EmptyDescription>
            ) : null}
          </EmptyHeader>
        </Empty>
      </div>
    </SidebarInset>
  );
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription>
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RefreshIcon size="md" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
