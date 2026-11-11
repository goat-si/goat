import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";

/** The environment of the GOAT Bot the person has chosen, read now; null before preferences load. */
export function currentGoatBotRefEnvironment(): string | null {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.goatBotRef?.environmentId ?? null)
    : null;
}
