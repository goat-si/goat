import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { SettingsActionRow } from "../components/SettingsActionRow";

/** Computer use details stay folded until asked for; the choice is remembered on this device. */
export function useComputerUseAdvanced() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  const expanded = loaded && preferences.value.computerUseAdvancedExpanded === true;
  const toggle = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        computerUseAdvancedExpanded: current.computerUseAdvancedExpanded !== true,
      }),
    });
  };
  return { expanded, toggle } as const;
}

export function ComputerUseAdvancedRow({
  advanced,
}: {
  readonly advanced: ReturnType<typeof useComputerUseAdvanced>;
}) {
  return (
    <SettingsActionRow
      icon={advanced.expanded ? "chevron.down" : "chevron.right"}
      label={advanced.expanded ? "Hide advanced" : "Advanced"}
      onPress={advanced.toggle}
    />
  );
}
