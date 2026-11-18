import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { PreviewSessionStack } from "../components/preview/sessions/PreviewSessionStack";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { SideChatCitationReveal } from "../lib/assistantCitationNavigation";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useShownThreadRouteTarget } from "../hooks/useShownThreadRouteTarget";

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const { shownTarget, modalOpen } = useShownThreadRouteTarget();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const sessionsEnvironmentId =
    shownTarget?.kind === "server" ? shownTarget.threadRef.environmentId : primaryEnvironmentId;
  return (
    <>
      <PreviewSessionStack
        environmentId={sessionsEnvironmentId}
        threadRef={shownTarget?.kind === "server" ? shownTarget.threadRef : null}
      />
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      <SideChatCitationReveal
        threadRef={shownTarget?.kind === "server" && !modalOpen ? shownTarget.threadRef : null}
      />
      {shownTarget ? (
        <ThreadRouteView target={shownTarget} background={modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
