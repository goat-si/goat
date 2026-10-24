import type { ComposerCapabilityContext } from "@goat/client-runtime/composerCapabilityItems";
import type { EnvironmentId, ProviderInteractionMode } from "@goat/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

/**
 * What the `@computer` entry needs to say whether it can run. The host check only runs while
 * the @ list is open, so typing elsewhere never asks the host about its screen.
 */
export function useComposerCapabilityContext(input: {
  readonly environmentId: EnvironmentId;
  readonly interactionMode: ProviderInteractionMode;
  readonly active: boolean;
}): ComposerCapabilityContext {
  const enabled = useEnvironmentSettings(input.environmentId, (settings) => settings.enableCua);
  const status = useEnvironmentQuery(
    input.active
      ? serverEnvironment.computerUse({ environmentId: input.environmentId, input: {} })
      : null,
  );
  const computerUse =
    status.data !== null && status.data !== undefined
      ? { enabled, status: status.data }
      : status.error !== null && status.error !== undefined
        ? { enabled, status: null }
        : null;
  return { computerUse, interactionMode: input.interactionMode };
}
