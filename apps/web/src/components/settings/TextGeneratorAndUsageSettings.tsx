import { useAtomValue } from "@effect/atom-react";
import { AuthProvidersManageScope, AuthSettingsWriteScope } from "@goat/contracts";
import type { ComponentProps } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { TextGeneratorSettings } from "./TextGeneratorSettings";
import { UsageProviderSettings as UsageSettings } from "./UsageProviderSettings";

export function UsageProviderSettings(props: ComponentProps<typeof UsageSettings>) {
  const settings = useEnvironmentSettings(props.environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canManage = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  const canSelect = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  return (
    <>
      {config?.environment.capabilities.textGenerators === true ? (
        <TextGeneratorSettings
          generators={settings.textGenerators}
          canManage={!props.readOnly && canManage}
          canSelect={!props.readOnly && canSelect}
          onPatch={async (patch) =>
            (await update({ environmentId: props.environmentId, input: { patch } }))._tag ===
            "Success"
          }
        />
      ) : null}
      <UsageSettings {...props} />
    </>
  );
}
