import {
  ServerSettingsError,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerSettings,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";

const MiniMaxCodeQuotaConsent = Context.Reference<boolean>(
  "goat/provider/MiniMaxCodeQuotaConsent",
  {
    defaultValue: () => false,
  },
);

export const withMiniMaxCodeQuotaConsent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, MiniMaxCodeQuotaConsent, true);

// Check raw settings so changing the command or source cannot make a dormant grant apply.
function grantedConfig(instance: ProviderInstanceConfig | undefined) {
  if (instance?.driver !== "acpRegistry") return;
  const { config } = instance;
  if (config === null || typeof config !== "object") return;
  const fields = config as Record<string, unknown>;
  return fields.readMiniMaxCodeQuota === true ? fields : undefined;
}

function quotaLaunchEnabled(
  settings: ServerSettings,
  id: keyof ServerSettings["providerInstances"],
  instance: ProviderInstanceConfig | undefined,
  config: Record<string, unknown>,
) {
  return (
    (instance?.enabled !== false && config.enabled !== false) ||
    Object.values(settings.projectSettingsOverrides).some(
      (project) => project?.providerInstances?.[id]?.enabled === true,
    )
  );
}

export const enforceMiniMaxCodeQuotaConsent = Effect.fn("enforceMiniMaxCodeQuotaConsent")(
  function* (current: ServerSettings, next: ServerSettings) {
    if (yield* MiniMaxCodeQuotaConsent) return;
    for (const id of Object.keys(next.providerInstances).map((key) => key as ProviderInstanceId)) {
      const instance = next.providerInstances[id];
      const config = grantedConfig(instance);
      if (!config) continue; // Disabling or removing the grant is always safe.
      const previous = current.providerInstances[id];
      const before = grantedConfig(previous);
      if (
        !before ||
        (!quotaLaunchEnabled(current, id, previous, before) &&
          quotaLaunchEnabled(next, id, instance, config)) ||
        !Equal.equals(
          [config.source, config.commandPath, config.commandArgs, instance?.environment ?? []],
          [before.source, before.commandPath, before.commandArgs, previous?.environment ?? []],
        )
      ) {
        return yield* new ServerSettingsError({
          settingsPath: "settings",
          operation: "normalize",
          providerInstanceId: id,
          cause: new Error(
            "Only a person in Settings enables MiniMax Code quota or changes its launch configuration while enabled.",
          ),
        });
      }
    }
  },
);
