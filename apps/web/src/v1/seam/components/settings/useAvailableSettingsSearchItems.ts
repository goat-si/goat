// Seam for v1 apps/web/src/components/settings/useAvailableSettingsSearchItems.ts (goat 916b5ccc1b2): GOAT 2 exposes only the provider settings rows.
import type { SettingsScopeSearch } from '../../../components/settings/settingsScope';
import { PROVIDER_SEARCH_ITEMS } from './settingsSearch';
export function useAvailableSettingsSearchItems(_scopeSearch: SettingsScopeSearch = {}) { return PROVIDER_SEARCH_ITEMS; }
