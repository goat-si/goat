// @effect-diagnostics cryptoRandomUUID:off - browser home claims use the platform UUID source.
import { createGoatBotHomeSync, resolveGoatBotHomeSelection } from "@goat/client-runtime/goatBot";
import { AuthSettingsWriteScope, type EnvironmentId, type GoatBotHomeClaim } from "@goat/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useGlobalAgentStore } from "~/globalAgentStore";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { useGoatBotEnvironments } from "./goatBotHooks";

/** Read raw home snapshots, and write only to connected, capable, permitted servers. */
export function useGoatBotHomeSettings() {
  const environments = useGoatBotEnvironments();
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const home = useMemo(
    () => resolveGoatBotHomeSelection(environments, botRef),
    [environments, botRef],
  );
  const writableIds = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const persist = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
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
        const result = await persist({ environmentId, input: { patch: { goatBotHome: claim } } });
        return result._tag === "Success";
      } catch {
        return false;
      }
    },
    [home.targets, persist],
  );
  return { ...home, environments, writableIds, write };
}

/** Mounted once by the sidebar; readers elsewhere never create or replicate a claim. */
export function useGoatBotHome() {
  const { targets, resolution, candidateId, writableIds, write } = useGoatBotHomeSettings();
  const [revision, wake] = useState(0);
  const [controller] = useState(() =>
    createGoatBotHomeSync({
      now: () => Date.now(),
      randomId: () => crypto.randomUUID(),
      onSettled: () => wake((value) => value + 1),
    }),
  );
  useEffect(() => {
    controller.setActive(true);
    return () => controller.setActive(false);
  }, [controller]);

  useEffect(() => {
    const { nextWakeAt } = controller.update({
      targets,
      resolution,
      candidateId,
      writableIds,
      write,
    });
    if (nextWakeAt === null) return;
    const timer = setTimeout(
      () => wake((value) => value + 1),
      Math.max(0, nextWakeAt - Date.now()),
    );
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Revision wakes retry planning after RPC completion or the backoff timer.
  }, [controller, targets, resolution, candidateId, writableIds, write, revision]);
}
