import { useContext, useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

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
  const session = useGoatBotSession();
  const homeSettings = useGoatBotHomeSettings();
  const moveTarget = homeSettings.moveTarget;
  const legacyAgentRoute = useLegacyGlobalAgentRoute();
  const navigate = useNavigate();
  const bot = session.availability.kind === "ready" ? session.availability.bot : null;
  useEffect(() => {
    if (bot)
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: bot.environmentId, threadId: bot.threadId },
        replace: true,
      });
  }, [bot, navigate]);
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

export const Route = createFileRoute("/_chat/bot")({
  component: GoatBotRouteView,
});
