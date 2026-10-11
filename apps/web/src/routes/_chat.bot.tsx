import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { GoatBotChatView } from "../components/goatBot/GoatBotChatView";
import {
  environmentSupportsChannelLedger,
  resolveGoatBotAvailability,
} from "../components/goatBot/goatBotAvailability";
import { SidebarInset } from "../components/ui/sidebar";
import { useComposerDraftStore } from "../composerDraftStore";
import { legacyGlobalAgentRoute } from "../globalAgentRoute";
import { useGlobalAgentStore } from "../globalAgentStore";
import { useThreadShell } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

const NO_ROWS = [] as const;
const noop = () => {};

/**
 * GOAT Bot's entry point. Until a server offers channels, it explains that
 * and keeps sending off; it never falls back to the global agent's provider.
 */
function GoatBotRouteView() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const legacyRef = useGlobalAgentStore((state) => state.ref);
  const legacyThreadRef = useMemo(
    () => (legacyRef === null ? null : scopeThreadRef(legacyRef.environmentId, legacyRef.threadId)),
    [legacyRef],
  );
  const legacyShell = useThreadShell(legacyThreadRef);
  const legacyDraftUnpromoted = useComposerDraftStore((store) => {
    const session = legacyRef === null ? null : store.getDraftSession(legacyRef.draftId);
    return session !== null && session.promotedTo == null;
  });
  const availability = resolveGoatBotAvailability({
    environments: environments.map((entry) => ({
      environmentId: entry.environmentId,
      connected: entry.connection.phase === "connected",
      supportsChannelLedger: environmentSupportsChannelLedger(
        entry.serverConfig?.environment.capabilities,
      ),
      primary: entry.environmentId === primaryEnvironmentId,
    })),
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
        legacyAgentRoute={legacyGlobalAgentRoute(legacyRef, legacyShell, legacyDraftUnpromoted)}
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/bot")({
  component: GoatBotRouteView,
});
