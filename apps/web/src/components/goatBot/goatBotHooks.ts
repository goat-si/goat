import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useMemo } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { type GlobalAgentLegacyRoute, legacyGlobalAgentRoute } from "~/globalAgentRoute";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { useThreadShell } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";

import {
  environmentSupportsChannelLedger,
  type GoatBotEnvironmentInput,
} from "./goatBotAvailability";

/** Every machine as GOAT Bot sees it: connected, offering channels, primary. */
export function useGoatBotEnvironments(): ReadonlyArray<GoatBotEnvironmentInput> {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useMemo(
    () =>
      environments.map((entry) => ({
        environmentId: entry.environmentId,
        connected: entry.connection.phase === "connected",
        supportsChannelLedger: environmentSupportsChannelLedger(
          entry.serverConfig?.environment.capabilities,
        ),
        primary: entry.environmentId === primaryEnvironmentId,
      })),
    [environments, primaryEnvironmentId],
  );
}

/** Where the old global agent still opens in its coding view, if anywhere. */
export function useLegacyGlobalAgentRoute(): GlobalAgentLegacyRoute | null {
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
  return legacyGlobalAgentRoute(legacyRef, legacyShell, legacyDraftUnpromoted);
}
