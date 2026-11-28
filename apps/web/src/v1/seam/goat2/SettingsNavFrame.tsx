// Seam for v1 apps/web/src/components/settings/SettingsSidebarNav.tsx (goat 916b5ccc1b2): provide v1 sidebar context at the GOAT 2 surface boundary.
import { SidebarProvider } from '../../components/ui/sidebar';
import { SettingsSidebarNav } from '../../components/settings/SettingsSidebarNav';

export function SettingsNavFrame(props: { pathname: string; placement?: 'page' | 'app-sidebar' }) {
  return <SidebarProvider className="min-h-0 w-auto"><SettingsSidebarNav {...props} /></SidebarProvider>;
}
