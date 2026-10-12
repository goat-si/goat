import { useAtomValue } from "@effect/atom-react";
import { resolveGoatBotHomeSelection } from "@t3tools/client-runtime/goatBot";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type GoatBotHomeClaim,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useMobileGoatBotEnvironments } from "./useMobileGoatBotEnvironments";

/** Reading home never starts synchronization; only the mounted worker does. */
export function useMobileGoatBotHomeSettings() {
  const environments = useMobileGoatBotEnvironments();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const preferencesLoaded = AsyncResult.isSuccess(preferences);
  const botRef = AsyncResult.isSuccess(preferences) ? (preferences.value.goatBotRef ?? null) : null;
  const home = useMemo(
    () => resolveGoatBotHomeSelection(environments, botRef),
    [environments, botRef],
  );
  const writableIds = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const write = useCallback(
    async (environmentId: EnvironmentId, claim: GoatBotHomeClaim) => {
      const target = home.targets.find((entry) => entry.environmentId === environmentId);
      if (
        !target?.connected ||
        !target.supportsHome ||
        !readEnvironmentScope(environmentId, AuthSettingsWriteScope)
      )
        return false;
      try {
        const result = await runAtomCommand(appAtomRegistry, serverEnvironment.updateSettings, {
          environmentId,
          input: { patch: { goatBotHome: claim } },
        });
        return result._tag === "Success";
      } catch {
        return false;
      }
    },
    [home.targets],
  );
  return { ...home, preferencesLoaded, environments, writableIds, write };
}
