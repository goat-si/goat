import { createFileRoute } from "@tanstack/react-router";

import { GoatBotChatView } from "../components/goatBot/GoatBotChatView";
import { resolveGoatBotAvailability } from "../components/goatBot/goatBotAvailability";
import {
  useGoatBotEnvironments,
  useLegacyGlobalAgentRoute,
} from "../components/goatBot/goatBotHooks";
import { SidebarInset } from "../components/ui/sidebar";

const NO_ROWS = [] as const;
const noop = () => {};

/**
 * GOAT Bot's entry point. Until a server offers channels, it explains that
 * and keeps sending off; it never falls back to the global agent's provider.
 */
function GoatBotRouteView() {
  const environments = useGoatBotEnvironments();
  const legacyAgentRoute = useLegacyGlobalAgentRoute();
  const availability = resolveGoatBotAvailability({
    environments,
    botRef: null,
    ensure: { state: "idle" },
  });
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <GoatBotChatView
        availability={availability}
        canOperate={false}
        rows={NO_ROWS}
        onSend={noop}
        onRetryInput={noop}
        legacyAgentRoute={legacyAgentRoute}
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/bot")({
  component: GoatBotRouteView,
});
