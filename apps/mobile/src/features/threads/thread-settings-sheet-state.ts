import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type { ProviderInstanceId } from "@goat/contracts";

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

export function favoritesFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  const favorites: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of models) {
    (favoriteKeys.has(model.key) ? favorites : others).push(model);
  }
  return [...favorites, ...others];
}

export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

export function canSelectModel(option: ModelOption, groups: ReadonlyArray<ProviderGroup>): boolean {
  return groups.some((group) =>
    group.models.some(
      (model) => model.key === option.key && !model.isUnavailable && !model.isHidden,
    ),
  );
}

export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}

// UIKit caps a sheet below the window (status bar, grabber; a form sheet on iPad), and content
// taller than the visible sheet would be clipped instead of scrolling, so stop well short of it.
const POPOVER_PHONE_MAX_FRACTION = 0.8;
const POPOVER_PAD_MAX_HEIGHT = 560;

/** The height a content-sized popover sheet gives its content; past the cap, the content scrolls. */
export function popoverSheetHeight(input: {
  readonly contentHeight: number;
  readonly windowHeight: number;
  readonly isPad: boolean;
}): number {
  const cap = input.isPad
    ? Math.min(POPOVER_PAD_MAX_HEIGHT, input.windowHeight * POPOVER_PHONE_MAX_FRACTION)
    : input.windowHeight * POPOVER_PHONE_MAX_FRACTION;
  return Math.round(Math.min(Math.max(0, input.contentHeight), cap));
}
