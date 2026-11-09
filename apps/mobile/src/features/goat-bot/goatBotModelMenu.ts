import type { deriveGoatBotModelSettings } from "@goat/client-runtime/goatBot";
import type { ModelSelection, ServerSettingsPatch } from "@goat/contracts";

type GoatBotModelSettings = ReturnType<typeof deriveGoatBotModelSettings>;

const AUTOMATIC = "automatic";
const SAME_AS_MAIN = "same";

export interface GoatBotModelMenuItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly selected: boolean;
}

/** The header menu: Automatic first, then every ready model, with the current one marked. */
export function goatBotModelMenu(state: GoatBotModelSettings, botName = "GOAT Bot") {
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
    accessibilityLabel: `${botName} model: ${modelName}${state.separate ? "" : " (automatic)"}`,
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

const sameModel = (left: ModelSelection | null, right: ModelSelection) =>
  left !== null && left.instanceId === right.instanceId && left.model === right.model;

/**
 * A member bot's header menu: the main bot's model first, then every ready model. The label is the
 * model its next turn really uses, its own or the main bot's.
 */
export function goatBotMemberModelMenu(
  state: GoatBotModelSettings,
  member: { readonly name: string; readonly defaultModelSelection: ModelSelection | null },
  mainName: string,
) {
  const own = member.defaultModelSelection;
  const label =
    own === null
      ? goatBotModelMenu(state, mainName).label
      : (state.choices.find((choice) => sameModel(own, choice.selection))?.label ?? own.model);
  const items: GoatBotModelMenuItem[] = [
    {
      id: SAME_AS_MAIN,
      title: `Same as ${mainName}`,
      subtitle: state.summaryLabel,
      selected: own === null,
    },
    ...state.choices.map((choice) => ({
      id: choice.key,
      title: choice.label,
      subtitle: choice.providerLabel,
      selected: sameModel(own, choice.selection),
    })),
  ];
  return {
    label,
    accessibilityLabel: `${member.name} model: ${label}${own === null ? ` (same as ${mainName})` : ""}`,
    items,
  };
}

/** A member's model for a menu choice: null for the main bot's, undefined when nothing changes. */
export function goatBotMemberModelChoice(
  state: GoatBotModelSettings,
  current: ModelSelection | null,
  id: string,
): ModelSelection | null | undefined {
  if (id === SAME_AS_MAIN) return current === null ? undefined : null;
  const choice = state.choices.find((entry) => entry.key === id);
  if (!choice || sameModel(current, choice.selection)) return undefined;
  return choice.selection;
}
