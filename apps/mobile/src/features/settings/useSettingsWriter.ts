import type { EnvironmentId, ServerSettingsPatch } from "@goat/contracts";
import { isAtomCommandInterrupted } from "@goat/client-runtime/state/runtime";

import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureText } from "./commandFailureText";
import type { ScopedMobileSettingsTarget } from "./settings-scoped-server";

export function useSettingsWriter() {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment settings update",
    reportFailure: true,
  });

  return async (
    targets: readonly ScopedMobileSettingsTarget[],
    writes: readonly {
      readonly environmentId: EnvironmentId;
      readonly patch: ServerSettingsPatch;
    }[],
  ) => {
    const outcomes = await Promise.all(
      writes.map(async (entry) => {
        const result = await updateSettings({
          environmentId: entry.environmentId,
          input: { patch: entry.patch },
        });
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
        const label =
          targets.find((target) => target.environment.environmentId === entry.environmentId)
            ?.environment.label ?? entry.environmentId;
        return `${label}: ${commandFailureText(result)}`;
      }),
    );
    const failures = outcomes.filter((outcome) => outcome !== null);
    if (failures.length > 0) {
      Dialog.alert("Could not save settings", failures.join("\n\n"));
    }
  };
}
