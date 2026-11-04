import { useContext, useEffect } from "react";
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
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { validateBotTaskSearch } from "../components/goatBot/botTaskSearch";
import { GoatBotChatView } from "../components/goatBot/GoatBotChatView";
import { GoatBotChannelContext } from "../components/goatBot/goatBotChannelPort";
import { useLegacyGlobalAgentRoute } from "../components/goatBot/goatBotHooks";
import { useGoatBotHomeSettings } from "../components/goatBot/useGoatBotHome";
import { useGoatBotSession } from "../components/goatBot/useGoatBotSession";
import { SidebarInset } from "../components/ui/sidebar";

/**
 * GOAT Bot's entry point. Until a server offers channels, it explains that
 * and keeps sending off; it never falls back to the global agent's provider.
 */
function GoatBotRouteView() {
  const port = useContext(GoatBotChannelContext);
  return <GoatBotRouteSession key={port ? "port" : "none"} />;
}

function GoatBotRouteSession() {
  const { task } = Route.useSearch();
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const ref = botRef ? scopeThreadRef(botRef.environmentId, botRef.threadId) : null;
  const shell = useThreadShell(ref);
  const items = useThreadVisibleTurnItems(
    resolveThreadDetailRef(ref, { shellExists: shell !== null, waitForShell: true }),
  );
  const session = useGoatBotSession(items, null);
  const homeSettings = useGoatBotHomeSettings();
  const moveTarget = homeSettings.moveTarget;
  const legacyAgentRoute = useLegacyGlobalAgentRoute();
  const navigate = useNavigate();
  const bot = session.availability.kind === "ready" ? session.availability.bot : null;
  useEffect(() => {
    if (bot && (task === undefined || !session.supportsTaskThreads))
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: bot.environmentId, threadId: bot.threadId },
        replace: true,
      });
  }, [bot, navigate, task, session.supportsTaskThreads]);
  if (bot && task && session.supportsTaskThreads)
    return <GoatBotTaskRoute environmentId={bot.environmentId} session={session} taskId={task} />;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <GoatBotChatView
        {...session}
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
  const besideChat = useClientSettings((settings) => settings.goatBotTaskThreadsBesideChat);
  const narrow = narrowViewport || !besideChat;
  const navigate = useNavigate();
  const legacyAgentRoute = useLegacyGlobalAgentRoute();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1">
        {!narrow && (
          <GoatBotChatView
            {...session}
            environmentId={environmentId}
            legacyAgentRoute={legacyAgentRoute}
          />
        )}
        <GoatBotTaskPane
          narrow={narrow}
          environmentId={environmentId}
          session={session}
          taskId={taskId}
          onClose={() => void navigate({ to: "/bot", search: {} })}
        />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/bot")({
  validateSearch: validateBotTaskSearch,
  component: GoatBotRouteView,
});
