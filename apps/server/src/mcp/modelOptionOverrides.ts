import type { ProviderOptionSelection } from "@goat/contracts";

/**
 * The options a delegated task runs with, local or remote alike: each explicit
 * id replaces its inherited value, other inherited values stay, and an empty
 * list clears them.
 */
export function overrideOptionSelections(
  inherited: ReadonlyArray<ProviderOptionSelection> | undefined,
  requested: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (requested === undefined) return inherited;
  const selections = new Map(
    (requested.length === 0 ? [] : (inherited ?? [])).map((selection) => [selection.id, selection]),
  );
  for (const selection of requested) selections.set(selection.id, selection);
  return [...selections.values()];
}
