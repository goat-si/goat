// GOAT 2's Settings > Providers page: v1's providers route body (routes/_chat.settings.providers.tsx at goat 916b5ccc1b2)
// for GOAT 2's one environment (no project scopes, so no projectIds), inside the toast providers v1's root mounts
// (routes/__root.tsx:164-168). v1's SettingsPageShell (breadcrumb header, close button) is app chrome GOAT 2's own top
// bar replaces (Paper board 1PBB-2), so the panel renders directly in the GOAT 2 frame's main area.
import type { ProviderInstanceId } from "@goat/contracts";
import { ProviderSettingsPanel } from "../../components/settings/ProviderSettingsPanel";
import { AnchoredToastProvider, ToastProvider } from "../../components/ui/toast";
import { GOAT2_ENVIRONMENT_ID } from "./environment";

export function ProvidersSettingsScreen({ instanceId }: { instanceId?: string }) {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <ProviderSettingsPanel
          environmentId={GOAT2_ENVIRONMENT_ID}
          {...(instanceId ? { instanceId: instanceId as ProviderInstanceId } : {})}
          projectIds={[]}
          scoped
        />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}
