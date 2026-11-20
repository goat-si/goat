export function resolveComposerMenuActiveItemId(input: {
  items: ReadonlyArray<{ id: string }>;
  highlightedItemId: string | null;
  currentSearchKey: string | null;
  highlightedSearchKey: string | null;
}): string | null {
  if (input.items.length === 0) {
    return null;
  }

  if (
    input.currentSearchKey === input.highlightedSearchKey &&
    input.highlightedItemId &&
    input.items.some((item) => item.id === input.highlightedItemId)
  ) {
    return input.highlightedItemId;
  }

  return input.items[0]?.id ?? null;
}

export function nudgeComposerMenuItem(
  composerMenuItems: ReadonlyArray<{ id: string }>,
  composerHighlightedItemId: string | null,
  key: "ArrowDown" | "ArrowUp",
): string | null {
  const highlightedIndex = composerMenuItems.findIndex(
    (item) => item.id === composerHighlightedItemId,
  );
  const normalizedIndex = highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
  const offset = key === "ArrowDown" ? 1 : -1;
  const nextIndex =
    (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
  const nextItem = composerMenuItems[nextIndex];
  return nextItem?.id ?? null;
}
