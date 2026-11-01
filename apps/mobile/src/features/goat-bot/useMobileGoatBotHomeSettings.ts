import {
  planGoatBotHomeChange,
  writeGoatBotHomeChange,
  pickGoatBotHomeMoveTarget,
} from "@goat/client-runtime/goatBot/home";
import { useAtomValue } from "@effect/atom-react";
import { resolveGoatBotHomeSelection } from "@goat/client-runtime/goatBot";
import { runAtomCommand } from "@goat/client-runtime/state/runtime";
import { AuthSettingsWriteScope, type EnvironmentId, type GoatBotHomeClaim } from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo, useRef, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const observedMax = useRef<GoatBotHomeClaim | null>(null);
  const moveTargetId = pickGoatBotHomeMoveTarget({
    targets: home.targets,
    writableIds,
    primaryEnvironmentId: environments.find((entry) => entry.primary)?.environmentId ?? null,
  });
  const moveTarget =
    moveTargetId === null
      ? null
      : {
          environmentId: moveTargetId,
          label:
            environments.find((entry) => entry.environmentId === moveTargetId)?.label ??
            moveTargetId.slice(0, 8),
        };
  function changeHome(environmentId: EnvironmentId) {
    if (busy || home.resolution.state === "unknown") return;
    const change = planGoatBotHomeChange({
      environmentId,
      targets: home.targets,
      writableIds,
      currentClaim: home.resolution.state === "claimed" ? home.resolution.claim : null,
      observedMax: observedMax.current,
      now: Date.now(),
      randomId: uuidv4,
    });
    if (change === null) return;
    observedMax.current = change.claim;
    setBusy(true);
    setError(null);
    void writeGoatBotHomeChange(change, write)
      .then((success) => {
        if (!success) setError("Could not save on every computer. Reconnect to sync the choice.");
      })
      .finally(() => setBusy(false));
  }
  return {
    busy,
    error,
    changeHome,
    moveTarget,
    ...home,
    preferencesLoaded,
    environments,
    writableIds,
    write,
  };
}
