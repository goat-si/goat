import { AuthSettingsWriteScope } from "@goat/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@goat/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type UnifiedSettings,
} from "@goat/contracts";

import { persistClientSettingsPatch, useMergedSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { readEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  createScopedSettingsWriter,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";
import { pendingScopedWritesAtom, settlePendingScopedWrite } from "./scopedSettingsOptimistic";

const writeScopedSettingsRaw = createScopedSettingsWriter(
  (environmentId) => readEnvironment(environmentId)?.serverConfig?.settings ?? null,
);

export function writeScopedSettings(
  environments: Parameters<typeof writeScopedSettingsRaw>[0],
  plan: Parameters<typeof writeScopedSettingsRaw>[1],
  persistServer: Parameters<typeof writeScopedSettingsRaw>[2],
  persistClient: Parameters<typeof writeScopedSettingsRaw>[3],
) {
  const save = {};
  const initial = plan(environments);
  if (initial.serverWrites.length > 0) {
    appAtomRegistry.update(pendingScopedWritesAtom, (writes) => [
      ...writes,
      ...initial.serverWrites.map(({ environmentId }) => ({
        save,
        environmentId,
        environments,
        plan,
      })),
    ]);
  }
  const settle = (
    environmentId: (typeof initial.serverWrites)[number]["environmentId"],
    saved?: ServerSettings,
  ) =>
    appAtomRegistry.update(pendingScopedWritesAtom, (writes) =>
      settlePendingScopedWrite(writes, save, environmentId, saved),
    );
  return writeScopedSettingsRaw(
    environments,
    plan,
    async (request) => {
      try {
        const result = await persistServer(request);
        settle(request.environmentId, result._tag === "Success" ? result.value : undefined);
        return result;
      } catch (error) {
        settle(request.environmentId);
        throw error;
      }
    },
    persistClient,
  ).then((result) => {
    for (const failure of result.failedEnvironments) settle(failure.environmentId);
    return result;
  });
}

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  return useMergedSettings(target?.settings ?? DEFAULT_SERVER_SETTINGS, selector);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return (
    environments: Parameters<typeof planScopedSettingsPatch>[1],
    makePlan: (
      environments: Parameters<typeof planScopedSettingsPatch>[1],
    ) => ReturnType<typeof planScopedSettingsPatch>,
    onFailed?: () => void,
  ) => {
    const plan = makePlan(environments);
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: "Setting not saved",
        description: plan.unavailableReason,
      });
      onFailed?.();
      return;
    }
    void writeScopedSettings(
      environments,
      makePlan,
      async (request) => {
        const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
          (scope) => !readEnvironmentScope(request.environmentId, scope),
        );
        if (missing)
          return AsyncResult.failure(
            Cause.fail(
              new EnvironmentAuthorizationError({
                requiredScope: missing,
                message: "This connection lacks permission to change these settings.",
              }),
            ),
          );
        return persistServer(request);
      },
      persistClientSettingsPatch,
    ).then(({ clientSaveFailed, failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
      if (!clientSaveFailed && failedEnvironments.length === 0) return;
      onFailed?.();
      toastManager.add({
        type: "error",
        title:
          savedEnvironmentCount > 0 ? "Setting saved on some environments" : "Setting not saved",
        description: [
          ...(clientSaveFailed ? ["Could not save settings on this device. Try again."] : []),
          ...failedEnvironments.map(
            ({ label, message }) => `Could not save on ${label}: ${message}`,
          ),
          ...(savedEnvironmentCount > 0
            ? [`Saved on ${savedEnvironments.map(({ label }) => label).join(", ")}.`]
            : []),
        ].join("\n"),
      });
    });
  };
}

export function useUpdateScopedSettings() {
  const { scope, environments, deviceOnly } = useSettingsScope();
  const run = useRunScopedPlan();
  /** `onFailed` runs when any target rejects or drops the patch, so a draft can fall back. */
  return (patch: ScopedSettingsPatch, options?: { readonly onFailed?: () => void }) =>
    run(
      environments,
      (current) => planScopedSettingsPatch(scope, current, patch, { deviceOnly }),
      options?.onFailed,
    );
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (keys: readonly ProjectScopedServerSettingKey[]) => {
    if (context === null) return;
    run(context.environments, (current) => planScopedSettingsClear(context.scope, current, keys));
  };
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (
    entries: readonly ProjectOverrideEntry[],
    keys: readonly ProjectScopedServerSettingKey[],
  ) => {
    if (context === null) return;
    run(context.environments, (current) => planProjectOverridesClear(current, entries, keys));
  };
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
