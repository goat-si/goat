import type { deriveGoatBotModelSettings } from "@goat/client-runtime/goatBot";
import type { ServerSettingsPatch } from "@goat/contracts";

type GoatBotModelSettings = ReturnType<typeof deriveGoatBotModelSettings>;

const AUTOMATIC = "automatic";

export interface GoatBotModelMenuItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly selected: boolean;
}

/** The header menu: Automatic first, then every ready model, with the current one marked. */
export function goatBotModelMenu(state: GoatBotModelSettings) {
  const current = state.choices.find(
    (choice) =>
      choice.instanceId === state.selection.instanceId && choice.model === state.selection.model,
  );
  const modelName = current?.label ?? state.selection.model;
  const items: GoatBotModelMenuItem[] = [
    {
      id: AUTOMATIC,
      title: "Automatic",
      subtitle: state.automaticDescription,
      selected: !state.separate,
    },
    ...state.choices.map((choice) => ({
      id: choice.key,
      title: choice.label,
      subtitle: choice.providerLabel,
      selected: state.separate && choice === current,
    })),
  ];
  return {
    label: modelName,
    accessibilityLabel: `GOAT Bot model: ${modelName}${state.separate ? "" : " (automatic)"}`,
    items,
  };
}

/** The settings change for a menu choice, or null when it is already in effect. */
export function goatBotModelMenuPatch(
  state: GoatBotModelSettings,
  id: string,
): ServerSettingsPatch | null {
  if (id === AUTOMATIC) return state.separate ? { goatBotModelSelection: null } : null;
  const choice = state.choices.find((entry) => entry.key === id);
  if (!choice) return null;
  const unchanged =
    state.separate &&
    state.selection.instanceId === choice.instanceId &&
    state.selection.model === choice.model;
  return unchanged ? null : { goatBotModelSelection: choice.selection };
}
