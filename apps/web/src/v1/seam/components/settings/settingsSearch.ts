// Seam for v1 apps/web/src/components/settings/settingsSearch.ts (goat 916b5ccc1b2): v1's settings search registry
// (1,397 lines across every settings page) is not carried; the provider page's rows keep v1's anchor ids and titles.
import { msg } from "gt-react";
import { normalizeSearchText } from "../../../lib/utils";
import { validateSettingsScopeSearch, type SettingsScopeSearch } from "../../../components/settings/settingsScope";

// Copied from v1 settingsSearch.ts lines 34–120.
export type SettingsPath =
  | "/settings/memory"
  | "/settings/projects"
  | "/settings/general"
  | "/settings/diagnostics"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/snap-shot"
  | "/settings/providers"
  | "/settings/integrations"
  | "/settings/goat-bot"
  | "/settings/decision-inbox"
  | "/settings/hub"
  | "/settings/scheduled-tasks"
  | "/settings/source-control"
  | "/settings/storage"
  | "/settings/connections"
  | "/settings/beta"
  | "/settings/archived";

export type SettingsSearchScope =
  | "environment"
  | "environment-defaults"
  | "project-defaults"
  | "project"
  | "checkout"
  | "connections";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  readonly searchTerms?: ReadonlyArray<string>;
  readonly scope?: SettingsSearchScope;
  readonly isVisible?: () => boolean;
  readonly desktopOnly?: boolean;
  readonly macOnly?: boolean;
  readonly windowsOnly?: boolean;
  readonly releaseChannelOnly?: boolean;
  readonly cloudOnly?: boolean;
  readonly environmentOnly?: boolean;
  readonly providerSettingsOnly?: boolean;
  readonly macProviderSettingsOnly?: boolean;
  readonly localBackendManagementOnly?: boolean;
  readonly localEnvironmentOnly?: boolean;
  readonly wslAvailableOnly?: boolean;
  readonly managedTunnelOnly?: boolean;
  readonly secondary?: boolean;
  readonly requiresMemory?: boolean;
  readonly requiresThreadAutoSettlement?: boolean;
  readonly requiresDesktopWindowMaterial?: boolean;
}

export interface SettingsSearchAvailability {
  readonly localEnvironmentDisabled?: boolean;
  readonly hasCloudPublicConfig: boolean;
  readonly hasEnvironment: boolean;
  readonly hasProviderSettingsEnvironment: boolean;
  readonly hasMacProviderSettingsEnvironment: boolean;
  readonly canManageLocalBackend: boolean;
  readonly isWslSettingsRowVisible: boolean;
  readonly hasThreadAutoSettlement: boolean;
  readonly hasMemory?: boolean;
  readonly managedTunnelActive?: boolean;
}

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/diagnostics": msg("Diagnostics"),
  "/settings/projects": msg("Project"),
  "/settings/general": msg("General"),
  "/settings/appearance": msg("Appearance"),
  "/settings/keybindings": msg("Keybindings"),
  "/settings/snap-shot": msg("SnapShots"),
  "/settings/providers": msg("Providers"),
  "/settings/memory": msg("Memory"),
  "/settings/integrations": msg("Integrations"),
  "/settings/goat-bot": "GOAT Bot",
  "/settings/decision-inbox": msg("Decision Inbox"),
  "/settings/hub": msg("Hub"),
  "/settings/scheduled-tasks": msg("Scheduled tasks"),
  "/settings/source-control": msg("Source control"),
  "/settings/storage": msg("Storage"),
  "/settings/connections": msg("Connections"),
  "/settings/beta": msg("Beta"),
  "/settings/archived": msg("Archived Threads"),
};

const PROVIDER_ROWS = {
  providers: { id: "providers", title: "Providers" },
  "provider-health-interval": { id: "provider-health-interval", title: "Provider health checks" },
} as const;

export type SettingsSearchItemId = keyof typeof PROVIDER_ROWS | (string & {});

export function searchableSetting(id: SettingsSearchItemId): { readonly id: string; readonly title: string } {
  const row = (PROVIDER_ROWS as Record<string, { id: string; title: string }>)[id];
  return row ?? { id, title: id };
}

// The seam indexes the two rows already exposed to the provider settings page.
export const PROVIDER_SEARCH_ITEMS: ReadonlyArray<SettingsSearchItem> = Object.values(PROVIDER_ROWS).map(
  (row) => ({
    ...row,
    to: "/settings/providers" as const,
    searchTerms: row.id === "providers"
      ? ["agents cli codex claude cursor grok fx opencode antigravity google sign in sign out install subscription instances authentication api key models configuration binary path config directory codex_home shadow home endpoint arguments environment variables display name accent color custom favorite hidden auto compact native sessions import resume", "opencodex home model route connect to home"]
      : ["refresh availability versions auth state models background probes seconds off"],
  }),
);

export function isSettingsOverviewVisible(search: SettingsScopeSearch): boolean {
  const target = validateSettingsScopeSearch({ ...search });
  return Boolean(target.project);
}

// These provider rows have no platform restrictions.
function settingsForThisPlatform(items: ReadonlyArray<SettingsSearchItem>): ReadonlyArray<SettingsSearchItem> {
  return items.filter((item) => item.isVisible?.() ?? true);
}

function titleMatchRank(title: string, query: string, queryTokens: ReadonlyArray<string>): number {
  if (title === query) return 5;
  if (title.startsWith(query)) return 4;
  if (title.includes(query)) return 3;
  return queryTokens.every((token) => title.includes(token)) ? 2 : 0;
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = PROVIDER_SEARCH_ITEMS,
  translate: (message: string) => string = (message) => message,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");
  return settingsForThisPlatform(items)
    .flatMap((item, index) => {
      const title = normalizeSearchText(item.title);
      const displayedTitle = normalizeSearchText(translate(item.title));
      const fields = [
        title,
        normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]),
        displayedTitle,
        normalizeSearchText(translate(SETTINGS_SECTION_LABELS[item.to])),
        ...(item.searchTerms ?? []).map(normalizeSearchText),
        ...(item.searchTerms ?? []).map((term) => normalizeSearchText(translate(term))),
      ];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];
      const rank = Math.max(
        titleMatchRank(title, normalizedQuery, queryTokens),
        titleMatchRank(displayedTitle, normalizedQuery, queryTokens),
        fields.some((field) => field.includes(normalizedQuery)) ? 1 : 0,
      );
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

// v1 reveals advanced typography before navigating; no provider row needs that state.
export function revealSettingsSearchTarget(_targetId: string): void {}
