import { AuthSettingsWriteScope, type EnvironmentId } from "@goat/contracts";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";

export function useGoatBotTemplateSupport(environmentId: EnvironmentId): boolean {
  const environment = useEnvironment(environmentId);
  const mayConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  return (
    mayConfigure && environment?.serverConfig?.environment.capabilities.goatBotTemplates === true
  );
}
