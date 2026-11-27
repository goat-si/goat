export const ADD_PROJECT_SCOPE_ITEM_VALUE = "add-project";

export function filterSidebarProjectScopeItems<TItem extends { readonly value: string }>(input: {
  items: readonly TItem[];
  query: string;
  matches: (item: TItem, query: string) => boolean;
}): readonly TItem[] {
  const query = input.query.trim();
  if (query.length === 0) return input.items;
  return input.items.filter(
    (item) =>
      item.value !== "all" &&
      item.value !== ADD_PROJECT_SCOPE_ITEM_VALUE &&
      input.matches(item, query),
  );
}
