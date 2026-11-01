import { useAtomValue } from "@effect/atom-react";
import { MemoryOperationId, type EnvironmentId, type MemoryHubSettingsView } from "@goat/contracts";
import { useEffect, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { memoryEnvironment } from "../../state/memory";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";

export function MemorySharingChoice({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canGet = useAtomValue(memoryEnvironment.hubSettingsGet.permissionAtom(environmentId));
  const canUpdate = useAtomValue(memoryEnvironment.hubSettingsUpdate.permissionAtom(environmentId));
  const get = useAtomCommand(memoryEnvironment.hubSettingsGet, { reportFailure: false });
  const update = useAtomCommand(memoryEnvironment.hubSettingsUpdate, { reportFailure: false });
  const [hub, setHub] = useState<MemoryHubSettingsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!canGet) return;
    let current = true;
    void get({ environmentId, input: {} }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") setHub(result.value);
      else setError("Could not load sharing settings.");
    });
    return () => {
      current = false;
    };
  }, [canGet, environmentId, get]);
  if (!config?.settings.memoryEnabled) return null;
  return (
    <SettingsSection title="Sharing">
      <SettingsRow
        title="Sync across devices"
        description={
          hub?.settings.mode === "member"
            ? "This device shares memory as a member. Change sharing in Settings > Memory."
            : "Share this device's memory with your other connected devices."
        }
        status={error ? <span role="alert">{error}</span> : undefined}
        control={
          <Switch
            aria-label="Sync across devices"
            checked={hub?.settings.mode !== "disabled" && hub !== null}
            disabled={!hub || !canUpdate || busy || hub.settings.mode === "member"}
            onCheckedChange={(checked) => {
              if (!hub || !canUpdate || busy || hub.settings.mode === "member") return;
              setBusy(true);
              setError(null);
              void update({
                environmentId,
                input: {
                  action: "configure",
                  requestId: MemoryOperationId.make(randomUUID()),
                  expectedVersion: hub.version,
                  settings: checked ? { mode: "hub", memorySpaceId: null } : { mode: "disabled" },
                },
              }).then((result) => {
                if (result._tag === "Success") setHub(result.value.view);
                else setError("Could not update sharing. Review Settings > Memory and try again.");
                setBusy(false);
              });
            }}
          />
        }
      />
    </SettingsSection>
  );
}
