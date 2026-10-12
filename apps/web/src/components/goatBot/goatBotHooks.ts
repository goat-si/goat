import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useMemo } from "react";

import { resolveEnvironmentOptionLabel } from "~/components/BranchToolbar.logic";

import { useComposerDraftStore } from "~/composerDraftStore";
import { type GlobalAgentLegacyRoute, legacyGlobalAgentRoute } from "~/globalAgentRoute";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { useThreadShell } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";

import {
  environmentSupportsChannelLedger,
  type GoatBotEnvironmentInput,
} from "@t3tools/client-runtime/goatBot";

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
        supportsBotStatus: entry.serverConfig?.environment.capabilities.goatBotStatus === true,
        primary: entry.environmentId === primaryEnvironmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary: entry.environmentId === primaryEnvironmentId,
          environmentId: entry.environmentId,
          runtimeLabel: entry.serverConfig?.environment.label ?? null,
          savedLabel: entry.label,
        }),
        settingsSnapshot: entry.serverConfig?.settings ?? null,
        homeTarget: {
          environmentId: entry.environmentId,
          connected: entry.connection.phase === "connected",
          supportsHome: entry.serverConfig?.environment.capabilities.goatBotHome === true,
          supportsBot: environmentSupportsChannelLedger(
            entry.serverConfig?.environment.capabilities,
          ),
          settingsLoaded: entry.serverConfig?.settings != null,
          home: entry.serverConfig?.settings?.goatBotHome ?? null,
        },
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
