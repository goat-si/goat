// Settings in the GOAT 2 workspace (Paper board 1PBB-2): the GOAT 2 frame (top bar, 44px rail) with v1's settings
// nav in the sidebar and the page in the main area. Providers is live (lifted v1 ProviderSettingsPanel); other v1
// settings sections are not built in GOAT 2 yet and say so.
import { useEffect, type ReactNode } from "react";
import { ProvidersSettingsScreen, V1Boundary, setV1Location, setV1Navigator } from "@v1/surfaces";
import * as P from "../paper/parts.tsx";
import { Planned } from "../planned/Planned.tsx";
import type { UiState } from "../ui-state/uiState.ts";

export const SETTINGS_PROVIDERS_PATH = "/settings/providers";
export const SETTINGS_GOAT_BOT_PATH = "/settings/goat-bot";

export function SettingsMode({ ui, setUi, top, rail, nav, botPage }: {
  ui: UiState;
  setUi: (patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)) => void;
  top: ReactNode;
  rail: ReactNode;
  /** v1's settings sidebar nav (null while the sidebar is closed). */
  nav: ReactNode;
  /** Settings > GOAT Bot for a bot (the main bot unless ?botId= names one). */
  botPage: (botId: string | null) => ReactNode;
}) {
  const path = ui.settingsPath ?? SETTINGS_PROVIDERS_PATH;
  const instanceId = typeof ui.settingsSearch?.instanceId === "string" ? ui.settingsSearch.instanceId : undefined;
  useEffect(() => {
    setV1Location({ pathname: path, search: ui.settingsSearch ?? {} });
    setV1Navigator((to) => {
      if (to.pathname.startsWith("/settings")) setUi({ mode: "settings", settingsPath: to.pathname, settingsSearch: to.search as Record<string, string> });
    });
  }, [path, ui.settingsSearch, setUi]);
  return (
    <P.Frame top={top} rail={rail} sidebar={ui.sidebarOpen ? nav : null}
      main={
        <V1Boundary data-settings-main="" style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "auto" }}>
          {path === SETTINGS_PROVIDERS_PATH
            ? <ProvidersSettingsScreen {...(instanceId ? { instanceId } : {})} />
            : path === SETTINGS_GOAT_BOT_PATH
              ? botPage(typeof ui.settingsSearch?.botId === "string" ? ui.settingsSearch.botId : null)
              : <div style={{ padding: 32 }}><Planned id="settings-accounts" /></div>}
        </V1Boundary>
      } />
  );
}
