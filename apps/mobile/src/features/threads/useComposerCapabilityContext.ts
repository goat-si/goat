import { useAtomValue } from "@effect/atom-react";
import type { ComposerCapabilityContext } from "@goat/client-runtime/composerCapabilityItems";
import type { EnvironmentId } from "@goat/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const NO_ENVIRONMENT = "" as EnvironmentId;

/**
 * What the `@computer` entry needs to say whether it can run. The host check only runs while
 * the @ list is open, so typing elsewhere never asks the host about its screen.
 */
export function useComposerCapabilityContext(input: {
  readonly environmentId: EnvironmentId | null;
  readonly active: boolean;
  readonly turn: Omit<ComposerCapabilityContext, "computerUse">;
}): ComposerCapabilityContext {
  const settings = useAtomValue(
    serverEnvironment.settingsValueAtom(input.environmentId ?? NO_ENVIRONMENT),
  );
  const query = useEnvironmentQuery(
    input.active && input.environmentId !== null
      ? serverEnvironment.computerUse({ environmentId: input.environmentId, input: {} })
      : null,
  );
  // A failed check is its own state: it must never read as "nothing is wrong".
  const computerUse =
    query.error !== null
      ? { error: query.error }
      : query.data !== null
        ? { enabled: settings?.enableCua === true, status: query.data }
        : null;
  return { ...input.turn, computerUse };
}
