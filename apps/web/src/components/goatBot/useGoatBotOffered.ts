import { useAtomValue } from "@effect/atom-react";
import { pickGoatBotEnvironment, resolveGoatBotHomeSelection } from "@goat/client-runtime/goatBot";
import { useContext } from "react";

import { useGlobalAgentStore } from "~/globalAgentStore";
import { projectEnvironmentPresentation } from "~/state/environmentProjection";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { GoatBotChannelContext } from "./goatBotChannelPort";
import { goatBotEnvironmentInputs } from "./goatBotEnvironmentInputs";
import { goatBotEnabledFor } from "./goatBotSessions";

/**
 * Whether GOAT Bot is offered, as useGoatBotEnabled decides it, for callers that need only that:
 * they re-render when it flips, not on every machine's connection step.
 */
export function useGoatBotOffered(): boolean {
  const port = useContext(GoatBotChannelContext);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const botRef = useGlobalAgentStore((state) => state.botRef);
  return useAtomValue(environmentPresentations.presentationsAtom, (presentationById) => {
    const environments = goatBotEnvironmentInputs(
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(environmentId, presentation),
      ),
      primaryEnvironmentId,
    );
    return goatBotEnabledFor(
      port,
      environments,
      resolveGoatBotHomeSelection(environments, botRef),
      pickGoatBotEnvironment(environments, botRef),
    );
  });
}
