import { scopeThreadRef } from "@goat/client-runtime/environment";

import { useComposerDraftStore } from "~/composerDraftStore";
import { type GlobalAgentLegacyRoute, legacyGlobalAgentRoute } from "~/globalAgentRoute";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { useThreadShell } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { goatBotEnvironmentInputs } from "./goatBotEnvironmentInputs";

import type { GoatBotEnvironmentInput } from "@goat/client-runtime/goatBot";

/** Every machine as GOAT Bot sees it: connected, offering channels, primary. */
export function useGoatBotEnvironments(): ReadonlyArray<GoatBotEnvironmentInput> {
  const { environments } = useEnvironments();
  return goatBotEnvironmentInputs(environments, usePrimaryEnvironmentId());
}

/** Where the old global agent still opens in its coding view, if anywhere. */
export function useLegacyGlobalAgentRoute(): GlobalAgentLegacyRoute | null {
  const legacyRef = useGlobalAgentStore((state) => state.ref);
  const legacyThreadRef =
    legacyRef === null ? null : scopeThreadRef(legacyRef.environmentId, legacyRef.threadId);
  const legacyShell = useThreadShell(legacyThreadRef);
  const legacyDraftUnpromoted = useComposerDraftStore((store) => {
    const session = legacyRef === null ? null : store.getDraftSession(legacyRef.draftId);
    return session !== null && session.promotedTo == null;
  });
  return legacyGlobalAgentRoute(legacyRef, legacyShell, legacyDraftUnpromoted);
}
