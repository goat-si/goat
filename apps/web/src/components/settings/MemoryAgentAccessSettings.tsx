import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import { useContext, useEffect, useRef, useState } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection, SettingsRow } from "./settingsLayout";
import { MemorySitesSettings } from "./MemorySitesSettings";
import { Switch } from "../ui/switch";

export function MemoryAgentAccessSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const enabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.enableAgentMemoryAccess,
  );
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <>
      <SettingsSection title="Agent access">
        <SettingsRow
          title="Allow agent memory access"
          description="Allow agents on this device to use memory within their granted scope. This is separate from sharing memories between devices."
          control={
            <Switch
              aria-label="Allow agent memory access"
              checked={enabled}
              disabled={!canUpdate || busy}
              onCheckedChange={(value) => {
                if (!registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId)))
                  return;
                setBusy(true);
                setMessage(null);
                void update({
                  environmentId,
                  input: { patch: { enableAgentMemoryAccess: value } },
                }).then((result) => {
                  if (!mounted.current) return;
                  setBusy(false);
                  setMessage(
                    result._tag === "Success"
                      ? "Agent memory access updated."
                      : "Could not update agent memory access.",
                  );
                });
              }}
            />
          }
          status={message ? <span role="status">{message}</span> : undefined}
        />
      </SettingsSection>
      <MemorySitesSettings environmentId={environmentId} />
    </>
  );
}
