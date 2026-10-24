import type { ComposerCapabilityContext } from "@goat/client-runtime/composerCapabilityItems";
import type { EnvironmentId } from "@goat/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

/**
 * What the `@computer` entry needs to say whether it can run. The host check only runs while
 * the @ list is open, so typing elsewhere never asks the host about its screen.
 */
export function useComposerCapabilityContext(input: {
  readonly environmentId: EnvironmentId;
  readonly active: boolean;
  readonly turn: Omit<ComposerCapabilityContext, "computerUse">;
}): ComposerCapabilityContext {
  const enabled = useEnvironmentSettings(input.environmentId, (settings) => settings.enableCua);
  const query = useEnvironmentQuery(
    input.active
      ? serverEnvironment.computerUse({ environmentId: input.environmentId, input: {} })
      : null,
  );
  // A failed check is its own state: it must never read as "nothing is wrong".
  const computerUse =
    query.error !== null && query.error !== undefined
      ? { error: query.error }
      : query.data !== null && query.data !== undefined
        ? { enabled, status: query.data }
        : null;
  return { ...input.turn, computerUse };
}
