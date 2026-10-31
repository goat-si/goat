import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import { useContext, useEffect, useEffectEvent, useState } from "react";

import { isElectron } from "../../env";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ComputerUsePanel, type ComputerUseSettingsPatch } from "./ComputerUsePanel";
import { CuaSetupDialog } from "./CuaSetupDialog";
import { readCuaGrants, type CuaPermission } from "./CuaSetupDialog.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { Button } from "../ui/button";

/** Computer use state and controls for one connected host. */
export function useComputerUseHost(environmentId: EnvironmentId, local: boolean) {
  const registry = useContext(RegistryContext);
  const enabled = useEnvironmentSettings(environmentId, (settings) => settings.enableCua);
  const disabledSkills = useEnvironmentSettings(
    environmentId,
    (settings) => settings.disabledBuiltInSkills,
  );
  const movePointer = useEnvironmentSettings(environmentId, (settings) => settings.cuaMovePointer);
  const allowedApps = useEnvironmentSettings(environmentId, (settings) => settings.cuaAllowedApps);
  const canConfigure = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const removeAllowed = useAtomCommand(serverEnvironment.removeComputerUseAllowedApp, {
    reportFailure: false,
  });
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
  // The desktop that runs the environment can also restart and prove its helper on Windows,
  // which has no grants to read (#1520).
  const localCheck =
    localMac ||
    (isElectron &&
      local &&
      query.data?.platform === "win32" &&
      bridge?.getClientPlatform?.() === "win32" &&
      typeof bridge.verifyCuaDriver === "function");

  const save = async (patch: ComputerUseSettingsPatch): Promise<string | null> => {
    if (!registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId)))
      return "This connection cannot change settings on this host.";
    const result = await update({ environmentId, input: { patch } });
    query.refresh();
    return result._tag === "Success" ? null : "Could not save the setting. Try again.";
  };
  const removeApp = async (app: string): Promise<string | null> => {
    if (!registry.get(serverEnvironment.removeComputerUseAllowedApp.permissionAtom(environmentId)))
      return "This connection cannot change settings on this host.";
    const result = await removeAllowed({ environmentId, input: { app } });
    query.refresh();
    return result._tag === "Success" ? null : "Could not save the setting. Try again.";
  };
  return {
    enabled,
    disabledSkills,
    movePointer,
    allowedApps,
    canConfigure,
    status: query.data,
    error: query.error,
    localMac,
    localCheck,
    save,
    removeApp,
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
      localCheck={host.localCheck}
      onCheck={checkGrants}
      onAllow={openGuide}
      onReveal={window.desktopBridge?.revealCuaGrantTarget}
      onRelaunch={window.desktopBridge?.relaunchForCuaGrants}
      onEnable={() => host.save({ enableCua: true })}
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
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const bridge = window.desktopBridge;
  return (
    <>
      <ComputerUsePanel
        environmentId={environmentId}
        hostLabel={hostLabel}
        enabled={host.enabled}
        canConfigure={host.canConfigure}
        status={host.status}
        error={host.error}
        localMac={host.localMac}
        localCheck={host.localCheck}
        disabledSkills={host.disabledSkills}
        movePointer={host.movePointer}
        save={host.save}
        bridge={{
          checkGrants,
          openGuide,
          verify: async () => {
            const verifyDriver = window.desktopBridge?.verifyCuaDriver;
            if (!verifyDriver) throw new Error("This desktop app cannot check computer use.");
            return verifyDriver().finally(host.refresh);
          },
          relaunch: bridge?.relaunchForCuaGrants,
          reveal: bridge?.revealCuaGrantTarget,
        }}
      />
      <SettingsRow title="Allowed apps" description="Apps always allowed on this environment.">
        {host.allowedApps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No apps always allowed.</p>
        ) : (
          host.allowedApps.map((app) => (
            <div key={app} className="flex items-center justify-between gap-3">
              <span className="text-sm">{app}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={!host.canConfigure || removing}
                onClick={() => {
                  setRemoving(true);
                  void host
                    .removeApp(app)
                    .then(setRemoveError)
                    .finally(() => setRemoving(false));
                }}
              >
                Remove
              </Button>
            </div>
          ))
        )}
        {removeError ? (
          <p role="alert" className="text-sm text-destructive">
            {removeError}
          </p>
        ) : null}
      </SettingsRow>
    </>
  );
}
