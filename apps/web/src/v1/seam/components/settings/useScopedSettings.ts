// Seam for v1 apps/web/src/components/settings/useScopedSettings.ts (goat 916b5ccc1b2): with no project overrides
// (seam scopedSettings.ts) there is nothing to clear.
export function useClearScopedSettings() {
  return (_keys: readonly string[]) => {};
}

export function useClearProjectOverrides() {
  return (_entries: readonly unknown[], _keys: readonly string[]) => {};
}
