import type { EnvironmentId, ServerSettingsPatch } from "@goat/contracts";
import { AppText as Text } from "../../../components/ui/AppText";
import { SettingsRow } from "../components/SettingsRow";
import type { ScopedMobileSettingsTarget } from "../settings-scoped-server";

export function AllowedApps({
  targets,
  disabled,
  onRemove,
}: {
  targets: readonly ScopedMobileSettingsTarget[];
  disabled: boolean;
  onRemove: (
    writes: readonly { environmentId: EnvironmentId; patch: ServerSettingsPatch }[],
  ) => void;
}) {
  return (
    <>
      <Text className="px-4 py-2 text-sm text-foreground-muted">Allowed apps</Text>
      {targets.every((target) => target.settings.cuaAllowedApps.length === 0) ? (
        <Text className="px-4 py-2 text-sm text-foreground-muted">No apps always allowed.</Text>
      ) : null}
      {targets.flatMap((target) =>
        target.settings.cuaAllowedApps.map((app) => (
          <SettingsRow
            key={`${target.environment.environmentId}:${app}`}
            icon="desktopcomputer"
            label={`Remove ${app}`}
            value={target.environment.label}
            disabled={disabled}
            onPress={() =>
              onRemove([
                {
                  environmentId: target.environment.environmentId,
                  patch: {
                    cuaAllowedApps: target.settings.cuaAllowedApps.filter((item) => item !== app),
                  },
                },
              ])
            }
          />
        )),
      )}
    </>
  );
}
