import { createFileRoute } from "@tanstack/react-router";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { MemorySettings } from "../components/settings/MemorySettings";
import { validateMemorySettingsSearch } from "../components/settings/MemorySettings.logic";
export const Route = createFileRoute("/settings/memory")({
  validateSearch: validateMemorySettingsSearch,
  component: MemoryRoute,
});
function MemoryRoute() {
  const target = Route.useSearch();
  const { environment } = useSettingsScope();
  return (
    <MemorySettings
      target={
        target.environmentId || !environment
          ? target
          : validateMemorySettingsSearch({ ...target, environmentId: environment.environmentId })
      }
    />
  );
}
