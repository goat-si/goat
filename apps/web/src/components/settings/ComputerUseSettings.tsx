import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import { useContext, useEffect, useEffectEvent, useState } from "react";

import { isElectron } from "../../env";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ComputerUseReadiness } from "../computerUse/ComputerUseReadiness";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useCuaGrants } from "./CuaGrantSteps";
import { CuaSetupDialog } from "./CuaSetupDialog";
import {
  CUA_PERMISSIONS,
  computerUseStatusText,
  computerUseUnavailable,
  cuaGranted,
  readCuaGrants,
  type CuaPermission,
} from "./CuaSetupDialog.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

/** Computer use state and controls for one connected host. */
export function useComputerUseHost(environmentId: EnvironmentId, local: boolean) {
  const registry = useContext(RegistryContext);
  const enabled = useEnvironmentSettings(environmentId, (settings) => settings.enableCua);
  const canConfigure = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const query = useEnvironmentQuery(serverEnvironment.computerUse({ environmentId, input: {} }));
  const refreshVisible = useEffectEvent(() => {
    if (!query.isPending && document.visibilityState !== "hidden") query.refresh();
  });
  // Driver state changes when agent sessions start, so recheck when the user comes back.
  useEffect(() => {
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, []);
  const bridge = window.desktopBridge;
  // Only the Mac that runs the environment can grant and prove its macOS permissions.
  const localMac =
    isElectron &&
    local &&
    query.data?.platform === "darwin" &&
    bridge?.getClientPlatform?.() === "darwin" &&
    typeof bridge.checkSystemPermission === "function" &&
    typeof bridge.verifyCuaDriver === "function";

  const save = async (enableCua: boolean): Promise<string | null> => {
    if (!registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId)))
      return "This connection cannot change settings on this host.";
    const result = await update({ environmentId, input: { patch: { enableCua } } });
    query.refresh();
    return result._tag === "Success" ? null : "Could not save the setting. Try again.";
  };
  return {
    enabled,
    canConfigure,
    status: query.data,
    error: query.error,
    localMac,
    save,
    refresh: query.refresh,
  };
}

export type ComputerUseHost = ReturnType<typeof useComputerUseHost>;

const checkGrants = () => readCuaGrants(window.desktopBridge);

const openGuide = async (permission: CuaPermission) => {
  const guide = window.desktopBridge?.openCuaPermissionGuide;
  if (!guide || !(await guide(permission))) throw new Error("Unable to open System Settings.");
};

export function ComputerUseSetup({
  host,
  hostLabel,
  onClose,
}: {
  host: ComputerUseHost;
  hostLabel: string;
  onClose: (outcome: "enabled" | "dismissed") => void;
}) {
  if (host.status === null) return null;
  return (
    <CuaSetupDialog
      enabled={host.enabled}
      hostLabel={hostLabel}
      status={host.status}
      localMac={host.localMac}
      onCheck={checkGrants}
      onAllow={openGuide}
      onReveal={window.desktopBridge?.revealCuaGrantTarget}
      onRelaunch={window.desktopBridge?.relaunchForCuaGrants}
      onEnable={() => host.save(true)}
      onVerify={async () => {
        const verifyDriver = window.desktopBridge?.verifyCuaDriver;
        if (!verifyDriver) throw new Error("This desktop app cannot check computer use.");
        return verifyDriver().finally(host.refresh);
      }}
      onClose={(outcome) => {
        host.refresh();
        onClose(outcome);
      }}
    />
  );
}

export function ComputerUseSettings() {
  const { environment, search } = useSettingsScope();
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  return (
    <SettingsSection id="computer" title="Computer">
      {connected && environment ? (
        <ComputerUseControls
          key={`${environment.environmentId}:${JSON.stringify(search)}`}
          environmentId={environment.environmentId}
          hostLabel={environment.label}
          local={environment.entry.target._tag === "PrimaryConnectionTarget"}
        />
      ) : (
        <SettingsRow
          {...searchableSetting("computer-use")}
          description="Connect an environment to turn on computer use for its computer."
        />
      )}
    </SettingsSection>
  );
}

function ComputerUseControls({
  environmentId,
  hostLabel,
  local,
}: {
  environmentId: EnvironmentId;
  hostLabel: string;
  local: boolean;
}) {
  const host = useComputerUseHost(environmentId, local);
  const [setupOpen, setSetupOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A grant revoked in System Settings shows here while the setting stays on.
  // Each check starts a helper process, so the row rechecks slowly and whenever GOAT regains focus.
  const grants = useCuaGrants(checkGrants, host.localMac && host.enabled && !setupOpen, 15_000);
  const current = host.localMac && host.enabled ? grants.grants : null;
  const missingGrants =
    current && current.principal !== "unusable"
      ? CUA_PERMISSIONS.filter((id) => !cuaGranted(current, id))
      : [];
  const supported = host.status !== null && !computerUseUnavailable(host.status);
  const statusText =
    saveError ??
    (current?.principal === "unusable" ? current.message : null) ??
    computerUseStatusText({
      enabled: host.enabled,
      status: host.status,
      error: host.error,
      missingGrants,
    });

  return (
    <>
      <SettingsRow
        {...searchableSetting("computer-use")}
        serverScoped
        settingKeys={["enableCua"]}
        description={`Let agents see and use apps on ${hostLabel} in the background, without taking over your cursor. Agents get the tools from their next turn; turning this off stops computer use right away.`}
        status={statusText ? <span role="status">{statusText}</span> : undefined}
        control={
          <div className="flex items-center gap-2">
            {host.enabled && supported ? (
              <Button
                size="xs"
                variant="outline"
                disabled={saving || !host.canConfigure}
                onClick={() => setSetupOpen(true)}
              >
                {host.localMac ? "Set up" : "Requirements"}
              </Button>
            ) : null}
            <Switch
              aria-label="Computer use"
              checked={host.enabled}
              disabled={saving || !host.canConfigure || (!host.enabled && !supported)}
              onCheckedChange={(checked) => {
                setSaveError(null);
                if (checked) {
                  setSetupOpen(true);
                  return;
                }
                setSaving(true);
                void host.save(false).then((failure) => {
                  setSaving(false);
                  setSaveError(failure);
                });
              }}
            />
          </div>
        }
      />
      <ComputerUseReadiness
        platform={host.status?.platform}
        readiness={host.status?.readiness}
        tools={host.status?.tools}
        signals={host.status?.signals}
      />
      {setupOpen && host.canConfigure ? (
        <ComputerUseSetup host={host} hostLabel={hostLabel} onClose={() => setSetupOpen(false)} />
      ) : null}
    </>
  );
}
