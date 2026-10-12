import { RefreshIcon } from "~/components/ui/refresh-icon";
import { scopeProjectRef, scopeThreadRef } from "@goat/client-runtime/environment";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { LinkIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { isElectron } from "../env";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
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
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShell,
  useThreadShells,
  waitForThreadShell,
} from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedStaticOnboardingState />;
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
  const setGlobalAgentRef = useGlobalAgentStore((state) => state.setRef);
  const globalThreadRef = useMemo(
    () =>
      globalAgentRef === null
        ? null
        : scopeThreadRef(globalAgentRef.environmentId, globalAgentRef.threadId),
    [globalAgentRef],
  );
  const globalThreadShell = useThreadShell(globalThreadRef);
  const globalDraftState = useComposerDraftStore((store): GlobalAgentDraftState => {
    const session = globalAgentRef === null ? null : store.getDraftSession(globalAgentRef.draftId);
    if (session === null) return "none";
    return session.promotedTo != null ? "promoted" : "unpromoted";
  });
  const startingRef = useRef(false);
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

  const mostRecentProject = useMemo(
    () =>
      bootstrapped
        ? (sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null)
        : null,
    [bootstrapped, projects, threads],
  );
  // Read at the end of an async run, after a confirm wait during which a project may arrive.
  const mostRecentProjectRef = useRef(mostRecentProject);
  mostRecentProjectRef.current = mostRecentProject;

  // A saved global agent keeps its machine. Without one: the primary machine,
  // then the only machine offering projectless threads.
  const preferredScratchEnvironmentId =
    globalAgentRef !== null
      ? scratchEnvironmentId(globalAgentRef.environmentId)
      : (scratchEnvironmentId(primaryEnvironmentId ?? null) ?? scratchEnvironmentId(null));
  // Read after a confirm wait, like mostRecentProjectRef below.
  const scratchEnvironmentIdRef = useRef(preferredScratchEnvironmentId);
  scratchEnvironmentIdRef.current = preferredScratchEnvironmentId;
  const resolution = resolveGlobalAgent({
    bootstrapped,
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
    if (startingRef.current || resolutionKind === "wait") return;
    startingRef.current = true;
    const fail = () => {
      if (!mountedRef.current) return;
      startingRef.current = false;
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
      if (!mountedRef.current) return;
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
    // Reads the live project: a confirm wait may have outlasted this run's inputs.
    const startFallback = async () => {
      const project = mostRecentProjectRef.current;
      if (project === null) {
        // Release so a project arriving later re-runs this effect (mostRecentProject is a
        // dependency), and show the hero meanwhile. fallbackReady is not a dependency,
        // so setting it cannot loop.
        startingRef.current = false;
        setFallbackReady(true);
        return;
      }
      await handleNewThread(scopeProjectRef(project.environmentId, project.id), { replace: true });
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
          readScratchEnvironmentId: () => scratchEnvironmentIdRef.current,
          waitForShell: () => waitForThreadShell(confirmRef, 5_000),
          readShell: () => readThreadShell(confirmRef),
        });
        // The wait can take seconds; never act after "/" has unmounted.
        if (!mountedRef.current) return undefined;
        if (settled.kind === "open-thread") {
          return openThread(settled.environmentId, settled.threadId);
        }
        if (settled.kind === "create") return createGlobalAgent(settled.environmentId);
        return startFallback();
      }
      return startFallback();
    };
    void run().catch(fail);
  }, [
    handleNewThread,
    mostRecentProject,
    navigate,
    openScratchProject,
    resolutionKind,
    setGlobalAgentRef,
    startState.retryRequest,
    targetDraftId,
    targetEnvironmentId,
    targetThreadId,
  ]);

  if (!bootstrapped) {
    return null;
  }
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

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();
  const localEnvironmentOff = isLocalEnvironmentDisabled();
  const description = localEnvironmentOff
    ? "The local environment is turned off. Connect a remote environment, or turn the local environment back on in Connections."
    : cloudEnabled
      ? "Enable T3 Connect on that machine, then open Connections here to sign in with the same account. You can also add the machine using a pairing link."
      : "Open Connections and add that machine using its pairing link. This app must be able to reach it.";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle>Connect to a computer running GOAT</EmptyTitle>
              <EmptyDescription>
                This app connects to GOAT running on your computer or a server. Start the GOAT
                desktop app or command-line server on that machine and keep it running.
              </EmptyDescription>
              <EmptyDescription>{description}</EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  Open Connections
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
