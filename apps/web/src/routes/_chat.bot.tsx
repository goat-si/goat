import { useContext, useEffect } from "react";
import { botRosterGroups } from "@goat/client-runtime/goatBot";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useGlobalAgentStore } from "../globalAgentStore";
import { useClientSettings } from "../hooks/useSettings";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  resolveThreadDetailRef,
  useThreadShell,
  useThreadVisibleTurnItems,
} from "../state/entities";
import { GoatBotTaskPane } from "../components/goatBot/GoatBotTaskPane";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { validateBotTaskSearch } from "../components/goatBot/botTaskSearch";
import { GoatBotChatView } from "../components/goatBot/GoatBotChatView";
import { GoatBotStepsProvider } from "../components/goatBot/GoatBotStepsProvider";
import { GoatBotChannelContext } from "../components/goatBot/goatBotChannelPort";
import { useLegacyGlobalAgentRoute } from "../components/goatBot/goatBotHooks";
import {
  GoatBotMainProfileContext,
  GoatBotMemberContext,
  goatBotSearch,
  useGoatBotMember,
} from "../components/goatBot/goatBotMemberContext";
import { useBotRoster } from "../components/goatBot/useBotRoster";
import { useBotManage } from "../components/goatBot/useBotManage";
import { useGoatBotHomeSettings } from "../components/goatBot/useGoatBotHome";
import { useGoatBotSession } from "../components/goatBot/useGoatBotSession";
import { useNewBotSlot } from "../components/goatBot/useNewBotSlot";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { requestTaskFocusReturn, getTaskPaneFocus } from "../components/goatBot/taskPaneFocus";

/**
 * GOAT Bot's entry point. Until a server offers channels, it explains that
 * and keeps sending off; it never falls back to the global agent's provider.
 */
function GoatBotRouteView() {
  const port = useContext(GoatBotChannelContext);
  return <GoatBotRouteSession key={port ? "port" : "none"} />;
}

function GoatBotRouteSession() {
  const { task, bot: botId } = Route.useSearch();
  const roster = useBotRoster();
  // A bot this client just created opens from the create's answer, even when the list read after
  // it failed.
  const created = useNewBotSlot(roster.environmentId).created;
  const member =
    botId === undefined
      ? null
      : (roster.bots?.find((bot) => bot.role === "member" && bot.botId === botId) ??
        created.find((bot) => bot.botId === botId) ??
        null);
  const main = botRosterGroups(roster.bots ?? []).main;
  // A named bot this client does not know yet waits for the roster; it never opens main instead.
  const memberUnknown = botId !== undefined && member === null;
  const memberResolving = memberUnknown && (!roster.botsLoaded || roster.botsPending);
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const ref = member
    ? scopeThreadRef(member.environmentId, member.sessionThreadId)
    : botId === undefined && botRef
      ? scopeThreadRef(botRef.environmentId, botRef.threadId)
      : null;
  const shell = useThreadShell(ref);
  const items = useThreadVisibleTurnItems(
    resolveThreadDetailRef(ref, { shellExists: shell !== null, waitForShell: true }),
  );
  const session = useGoatBotSession(items, null, member);
  const homeSettings = useGoatBotHomeSettings();
  const moveTarget = homeSettings.moveTarget;
  const legacyAgentRoute = useLegacyGlobalAgentRoute();
  const navigate = useNavigate();
  const bot =
    !memberUnknown && session.availability.kind === "ready" ? session.availability.bot : null;
  useEffect(() => {
    if (bot && (task === undefined || !session.supportsTaskThreads))
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: bot.environmentId, threadId: bot.threadId },
        replace: true,
      });
  }, [bot, navigate, task, session.supportsTaskThreads]);
  if (memberUnknown && !memberResolving) return <GoatBotMemberMissing />;
  if (bot && task && session.supportsTaskThreads)
    return (
      <GoatBotMainProfileContext value={main}>
        <GoatBotMemberContext value={member}>
          <GoatBotTaskRoute environmentId={bot.environmentId} session={session} taskId={task} />
        </GoatBotMemberContext>
      </GoatBotMainProfileContext>
    );
  return (
    <GoatBotMainProfileContext value={main}>
      <GoatBotMemberContext value={member}>
        <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
          <GoatBotStepsProvider visibleTurnItems={items} environmentId={bot?.environmentId ?? null}>
            <GoatBotChatView
              {...session}
              {...(memberResolving && roster.environmentId !== null
                ? {
                    availability: {
                      kind: "connecting" as const,
                      environmentId: roster.environmentId,
                    },
                  }
                : {})}
              environmentId={bot?.environmentId ?? null}
              legacyAgentRoute={legacyAgentRoute}
              homeMove={
                moveTarget
                  ? {
                      label: moveTarget.label,
                      busy: homeSettings.busy,
                      onMove: () => homeSettings.changeHome(moveTarget.environmentId),
                    }
                  : undefined
              }
              homeMoveError={homeSettings.error}
            />
          </GoatBotStepsProvider>
        </SidebarInset>
      </GoatBotMemberContext>
    </GoatBotMainProfileContext>
  );
}

function GoatBotMemberMissing() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <Empty className="min-h-0 flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>This bot isn't available</EmptyTitle>
          <EmptyDescription>It may belong to another account or server.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex justify-center">
            <Button size="sm" variant="outline" render={<Link to="/bot" search={{}} />}>
              Open GOAT Bot
            </Button>
          </div>
        </EmptyContent>
      </Empty>
    </SidebarInset>
  );
}

export function GoatBotTaskRoute({
  environmentId,
  session,
  taskId,
}: {
  environmentId: EnvironmentId;
  session: ReturnType<typeof useGoatBotSession>;
  taskId: ChannelTaskId;
}) {
  const narrowViewport = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const taskFocus = getTaskPaneFocus();
  const besideChat = useClientSettings((settings) => settings.goatBotTaskThreadsBesideChat);
  const narrow = narrowViewport || !besideChat;
  const navigate = useNavigate();
  const legacyAgentRoute = useLegacyGlobalAgentRoute();
  const member = useGoatBotMember();
  const manage = useBotManage(environmentId);
  const memberDeleted = member?.state === "deleted";
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1">
        {!narrow && (
          <GoatBotStepsProvider
            visibleTurnItems={session.visibleTurnItems}
            environmentId={memberDeleted ? null : environmentId}
          >
            <GoatBotChatView
              {...session}
              environmentId={environmentId}
              legacyAgentRoute={legacyAgentRoute}
              removal={memberDeleted ? "deleted" : null}
              onRestore={
                memberDeleted && manage.canManage ? () => void manage.restore(member) : undefined
              }
            />
          </GoatBotStepsProvider>
        )}
        <GoatBotTaskPane
          narrow={narrow}
          environmentId={environmentId}
          session={session}
          taskId={taskId}
          onClose={() => {
            requestTaskFocusReturn(taskFocus);
            void navigate({ to: "/bot", search: goatBotSearch(member) });
          }}
        />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/bot")({
  validateSearch: validateBotTaskSearch,
  component: GoatBotRouteView,
});
