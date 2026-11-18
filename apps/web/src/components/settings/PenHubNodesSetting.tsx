import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Whether this environment's server lists the other machines of its Pen mesh as hub devices. An
 * older GOAT drops the setting on save, which the row reports.
 */
export function PenHubNodesSetting({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const enabled = useEnvironmentSettings(environmentId, (value) => value.penHubNodes);
  const canConfigure = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (penHubNodes: boolean) => {
    setSaving(true);
    setError(null);
    const result = await update({ environmentId, input: { patch: { penHubNodes } } });
    setSaving(false);
    if (result._tag === "Failure") setError("Could not save. Try again.");
    else if (result.value.penHubNodes !== penHubNodes)
      setError(
        "This machine runs an older GOAT that does not follow Pen. Update GOAT there first.",
      );
  };
  return (
    <SettingsRow
      {...searchableSetting("hub-pen-machines")}
      serverScoped
      settingKeys={["penHubNodes"]}
      description="When this server is in a Pen mesh, list every other machine in the mesh under hub devices and remove it when it leaves. It only attaches to a GOAT a machine already has; a phone still needs hub access to open one."
      status={
        error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : undefined
      }
      control={
        <Switch
          aria-label="List Pen machines as hub devices"
          checked={enabled}
          disabled={saving || !canConfigure}
          onCheckedChange={(checked) => void save(Boolean(checked))}
        />
      }
    />
  );
}
