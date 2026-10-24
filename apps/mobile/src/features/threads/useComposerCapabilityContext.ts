import { useAtomValue } from "@effect/atom-react";
import type { ComposerCapabilityContext } from "@goat/client-runtime/composerCapabilityItems";
import type { EnvironmentId, ProviderInteractionMode } from "@goat/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const NO_ENVIRONMENT = "" as EnvironmentId;

/**
 * What the `@computer` entry needs to say whether it can run. The host check only runs while
 * the @ list is open, so typing elsewhere never asks the host about its screen.
 */
export function useComposerCapabilityContext(input: {
  readonly environmentId: EnvironmentId | null;
  readonly interactionMode: ProviderInteractionMode;
  readonly active: boolean;
}): ComposerCapabilityContext {
  const settings = useAtomValue(
    serverEnvironment.settingsValueAtom(input.environmentId ?? NO_ENVIRONMENT),
  );
  const status = useEnvironmentQuery(
    input.active && input.environmentId !== null
      ? serverEnvironment.computerUse({ environmentId: input.environmentId, input: {} })
      : null,
  );
  const enabled = settings?.enableCua === true;
  const computerUse =
    status.data !== null
      ? { enabled, status: status.data }
      : status.error !== null
        ? { enabled, status: null }
        : null;
  return { computerUse, interactionMode: input.interactionMode };
}
