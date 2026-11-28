// Seam for v1 apps/web/src/components/settings/settingsSearch.ts (goat 916b5ccc1b2): v1's settings search registry
// (1,397 lines across every settings page) is not carried; the provider page's rows keep v1's anchor ids and titles.
const PROVIDER_ROWS = {
  providers: { id: "providers", title: "Providers" },
  "provider-health-interval": { id: "provider-health-interval", title: "Provider health checks" },
} as const;

export type SettingsSearchItemId = keyof typeof PROVIDER_ROWS | (string & {});

export function searchableSetting(id: SettingsSearchItemId): { readonly id: string; readonly title: string } {
  const row = (PROVIDER_ROWS as Record<string, { id: string; title: string }>)[id];
  return row ?? { id, title: id };
}
