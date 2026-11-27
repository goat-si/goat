import { msg, useGT, useMessages } from "gt-react";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { isGoatConnectEnabled } from "@goat/shared/goatConnect";
import { cloudAutoJoinSaveError, connectHubProxySaveError } from "@goat/client-runtime/hub-devices";
import { hubSnapshot, type HubSnapshot } from "@goat/client-runtime/state/hub-fleet";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type GoatclawSettings,
  type GoatclawHostSyncState,
  type HostStatusEntry,
  HubCloudHolder,
  type HubSettings as HubSettingsValue,
  type OpenCodexInventorySnapshot,
} from "@goat/contracts";
import { useContext, useState } from "react";

import { isElectron } from "~/env";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { HOST_STATUS_REFRESH_MS, hostStatusAtom, refreshHostStatus } from "~/state/hostStatus";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { profileLabel } from "../desktop/firstRunPrompts.logic";
import { Button } from "../ui/button";
import { OpenCodexSyncButton } from "../opencodex/OpenCodexSyncDialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DisposableMachinesSettings } from "./DisposableMachinesSettings";
import { useHubActions } from "./HubDeviceActions";
import { HubDeviceListSection } from "./HubDeviceList";
import { HubRelayWarningRow } from "./HubRelayWarningSettings";
import { PenHubNodesSetting } from "./PenHubNodesSetting";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const CLOUD_HOLDER_LABEL: Record<HubSettingsValue["cloudHolder"], string> = {
  hub: msg("On this hub"),
  auto: msg("Wherever signed in"),
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const GOATCLAW_HOST_STATE: Record<GoatclawHostSyncState, string> = {
  applied: msg("applied"),
  pending: msg("waiting"),
  outdated: msg("needs a GOAT update"),
};
const GOATCLAW_HOST_ORDER: ReadonlyArray<GoatclawHostSyncState> = [
  "outdated",
  "pending",
  "applied",
];
const GOATCLAW_HOSTS_SHOWN = 2;

/** Where the policy has not landed comes first; the rest folds into +N, the full list into the tooltip. */
function goatclawFleetStatus(
  m: ReturnType<typeof useMessages>,
  hosts: ReadonlyArray<HostStatusEntry>,
) {
  const rows = hosts
    .flatMap((entry) =>
      entry.host === null || entry.goatclaw === undefined
        ? []
        : [{ host: entry.host, state: entry.goatclaw.state }],
    )
    .toSorted(
      (left, right) =>
        GOATCLAW_HOST_ORDER.indexOf(left.state) - GOATCLAW_HOST_ORDER.indexOf(right.state),
    )
    .map((row) => `${row.host} ${m(GOATCLAW_HOST_STATE[row.state])}`);
  if (rows.length === 0) return null;
  const rest = rows.length - GOATCLAW_HOSTS_SHOWN;
  return {
    summary: [...rows.slice(0, GOATCLAW_HOSTS_SHOWN), ...(rest > 0 ? [`+${rest}`] : [])].join(
      " · ",
    ),
    full: rows.join("\n"),
  };
}

function homeStatusText(
  gt: ReturnType<typeof useGT>,
  reading: boolean,
  snapshot: HubSnapshot | null,
  home: OpenCodexInventorySnapshot | undefined,
) {
  if (reading) return gt("Reading OpenCodex…");
  const version = (value: string | null | undefined) =>
    value ? `OpenCodex ${value}` : "OpenCodex";
  if (snapshot !== null)
    return [
      gt("{version} Home", { version: version(snapshot.homeVersion) }),
      snapshot.homeName,
      snapshot.homeHealthy ? null : gt("not answering"),
    ]
      .filter((part) => part !== null)
      .join(" · ");
  return home?.installed
    ? gt("{version} here is not a Home yet: it has no linked devices.", {
        version: version(home.runtime.version),
      })
    : gt("OpenCodex is not installed on this machine.");
}

export function HubSettings() {
  const gt = useGT();
  const setting = useTranslatedSearchableSetting();
  const { environment } = useSettingsScope();
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  return (
    <SettingsPageContainer>
      {connected && environment ? (
        <HubControls
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
          local={environment.entry.target._tag === "PrimaryConnectionTarget"}
        />
      ) : (
        <SettingsSection id="hub" title={gt("Hub")}>
          <SettingsRow
            {...setting("hub-enabled")}
            description={gt(
              "Connect an environment to choose whether it runs your fleet as the hub.",
            )}
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function useHubSettings(environmentId: EnvironmentId) {
  const gt = useGT();
  const registry = useContext(RegistryContext);
  const settings = useEnvironmentSettings(environmentId, (value) => value.hub);
  const goatclaw = useEnvironmentSettings(environmentId, (value) => value.goatclaw);
  const canConfigure = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const savePatch = async (
    patch:
      | { readonly hub: Partial<HubSettingsValue> }
      | { readonly goatclaw: Partial<Pick<GoatclawSettings, "enabled" | "defaultProfile">> },
  ) => {
    if (!registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId))) return null;
    setSaving(true);
    setError(null);
    const result = await update({ environmentId, input: { patch } });
    setSaving(false);
    if (result._tag === "Failure") {
      setError(gt("Could not save the setting. Try again."));
      return null;
    }
    return result.value;
  };
  return {
    settings,
    goatclaw,
    canConfigure,
    saving,
    error,
    joinError,
    save: async (hub: Partial<HubSettingsValue>) => {
      const saved = await savePatch({ hub });
      if (saved !== null && hub.connectDevicesHubProxy !== undefined)
        setError(
          connectHubProxySaveError(hub.connectDevicesHubProxy, saved.hub.connectDevicesHubProxy),
        );
    },
    /** An older hub drops the field and answers on, since it always joins its cloud machines. */
    saveCloudAutoJoin: async (autoJoinCloudMachines: boolean) => {
      setJoinError(null);
      const saved = await savePatch({ hub: { autoJoinCloudMachines } });
      if (saved !== null)
        setJoinError(
          cloudAutoJoinSaveError(autoJoinCloudMachines, saved.hub.autoJoinCloudMachines),
        );
    },
    saveGoatclaw: (goatclaw: Partial<Pick<GoatclawSettings, "enabled" | "defaultProfile">>) =>
      savePatch({ goatclaw }),
  };
}

function HubControls({
  environmentId,
  label,
  local,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly local: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const setting = useTranslatedSearchableSetting();
  const registry = useContext(RegistryContext);
  const hub = useHubSettings(environmentId);
  const atom = hostStatusAtom(environmentId);
  const result = useAtomValue(atom);
  const reachesHosts = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const actions = useHubActions(environmentId, () => registry.refresh(atom));
  useLiveRefresh(() => refreshHostStatus(registry, atom), {
    key: `hub:${environmentId}`,
    intervalMs: HOST_STATUS_REFRESH_MS,
  });
  const hosts: ReadonlyArray<HostStatusEntry> = result._tag === "Success" ? result.value.hosts : [];
  const snapshot = hubSnapshot(
    hosts.map((entry) => ({ key: entry.host ?? "", label: entry.host ?? label, entry })),
  );
  const home = hosts.find((entry) => entry.host === null)?.metrics?.opencodex;
  const profileName = (id: string) => {
    switch (id) {
      case "owner":
        return gt("Owner");
      case "worker":
        return gt("Worker");
      case "manager":
        return gt("Manager");
      case "observer":
        return gt("Observer");
      default:
        return profileLabel(id);
    }
  };
  const homeStatus = homeStatusText(gt, result._tag === "Initial", snapshot, home);
  const fleetGoatclaw = goatclawFleetStatus(m, hosts);
  const dashboard =
    local && home?.installed && (isElectron || LOOPBACK.has(window.location.hostname))
      ? `http://127.0.0.1:${home.runtime.port}/`
      : null;

  return (
    <>
      <SettingsSection id="hub" title={gt("Hub")}>
        <SettingsRow
          {...setting("hub-enabled")}
          serverScoped
          settingKeys={["hub"]}
          description={gt(
            "{machine} checks every linked device's parity every 30 minutes and holds cloud runs. When a device cannot reach it, goal work there pauses and you get a decision. Devices and OpenCodex settings stay as they are.",
            { machine: label },
          )}
          status={
            hub.error ? (
              <span role="alert" className="text-destructive">
                {hub.error}
              </span>
            ) : (
              <span role="status">{homeStatus}</span>
            )
          }
          control={
            <Switch
              aria-label={setting("hub-enabled").title}
              checked={hub.settings.enabled}
              disabled={hub.saving || !hub.canConfigure}
              onCheckedChange={(enabled) => void hub.save({ enabled })}
            />
          }
        />
        {isGoatConnectEnabled() && (
          <SettingsRow
            {...setting("hub-connect-access")}
            serverScoped
            settingKeys={["hub"]}
            description={gt(
              "Standing consent for every trusted device signed in to the linked GOAT Connect account to reach hub devices. After enabling, sign out of GOAT Connect and sign back in. Turning this off ends privileged Connect sessions, including direct hub access. The preference stays saved while the hub is off.",
            )}
            control={
              <Switch
                aria-label={setting("hub-connect-access").title}
                checked={hub.settings.connectDevicesHubProxy}
                disabled={hub.saving || !hub.canConfigure || !hub.settings.enabled}
                onCheckedChange={(connectDevicesHubProxy) =>
                  void hub.save({ connectDevicesHubProxy })
                }
              />
            }
          />
        )}
        <SettingsRow
          {...setting("hub-cloud-holder")}
          serverScoped
          settingKeys={["hub"]}
          description={gt(
            "Where Claude Cloud, Cursor Cloud and Devin Cloud runs start by default.",
          )}
          control={
            <Select
              value={hub.settings.cloudHolder}
              disabled={hub.saving || !hub.canConfigure || !hub.settings.enabled}
              onValueChange={(value) => {
                if (value === "hub" || value === "auto") void hub.save({ cloudHolder: value });
              }}
            >
              <SelectTrigger size="sm" aria-label={setting("hub-cloud-holder").title}>
                <SelectValue>
                  {(value: HubSettingsValue["cloudHolder"]) => m(CLOUD_HOLDER_LABEL[value])}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {HubCloudHolder.literals.map((value) => (
                  <SelectItem key={value} value={value}>
                    {m(CLOUD_HOLDER_LABEL[value])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...setting("hub-cloud-auto-join")}
          serverScoped
          settingKeys={["hub"]}
          description={gt(
            "A cloud machine this hub creates joins as a Child the first time it is used: GOAT installs OpenCodex and Codex, links it, and verifies one request through Home, so it needs no sign-in there. Off: new machines stay standalone, and linked ones stay linked.",
          )}
          status={
            hub.joinError ? (
              <span role="alert" className="text-destructive">
                {hub.joinError}
              </span>
            ) : undefined
          }
          control={
            <Switch
              aria-label={setting("hub-cloud-auto-join").title}
              checked={hub.settings.autoJoinCloudMachines}
              disabled={hub.saving || !hub.canConfigure || !hub.settings.enabled}
              onCheckedChange={(checked) => void hub.saveCloudAutoJoin(checked)}
            />
          }
        />
        <PenHubNodesSetting environmentId={environmentId} />
        <HubRelayWarningRow
          environmentId={environmentId}
          warning={home?.link.relayWarning ?? null}
        />
        <SettingsRow
          {...setting("hub-permission-profiles")}
          serverScoped
          settingKeys={["goatclaw"]}
          description={gt(
            "Agents can launch, merge or change settings only as far as their profile allows. Agents without one get the default profile. Applies to every connected host: switching it here switches it there too.",
          )}
          status={
            fleetGoatclaw === null ? undefined : (
              <Tooltip>
                <TooltipTrigger payload={fleetGoatclaw.full} render={<span role="status" />}>
                  {fleetGoatclaw.summary}
                </TooltipTrigger>
                <TooltipPopup side="top" className="whitespace-pre-wrap">
                  {fleetGoatclaw.full}
                </TooltipPopup>
              </Tooltip>
            )
          }
          control={
            <Switch
              aria-label={setting("hub-permission-profiles").title}
              checked={hub.goatclaw.enabled}
              disabled={hub.saving || !hub.canConfigure}
              onCheckedChange={(enabled) => void hub.saveGoatclaw({ enabled })}
            />
          }
        />
        <SettingsRow
          {...setting("hub-default-profile")}
          serverScoped
          settingKeys={["goatclaw"]}
          description={gt("The profile for agents launched without one.")}
          control={
            <Select
              value={hub.goatclaw.defaultProfile}
              disabled={hub.saving || !hub.canConfigure || !hub.goatclaw.enabled}
              onValueChange={(value) => {
                if (typeof value === "string") void hub.saveGoatclaw({ defaultProfile: value });
              }}
            >
              <SelectTrigger size="sm" aria-label={setting("hub-default-profile").title}>
                <SelectValue>{(value: string) => profileName(value)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {Object.keys(hub.goatclaw.profiles).map((id) => (
                  <SelectItem key={id} value={id}>
                    {profileName(id)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {dashboard === null ? null : (
          <SettingsRow
            title={gt("Accounts and keys")}
            description={gt("OpenCodex keeps every sign-in and key. GOAT never shows them.")}
            control={
              <Button
                size="xs"
                variant="outline"
                render={<a href={dashboard} target="_blank" rel="noreferrer" />}
              >
                {gt("Open OpenCodex")}
              </Button>
            }
          />
        )}
        {home?.installed ? (
          <SettingsRow
            title={gt("OpenCodex models")}
            description={gt(
              "Load OpenCodex's current models into Codex here, then on each linked Child. Children take this Home's models and settings. GOAT also syncs after every managed OpenCodex update.",
            )}
            control={<OpenCodexSyncButton environmentId={environmentId} homeLabel={label} />}
          />
        ) : null}
      </SettingsSection>
      <DisposableMachinesSettings environmentId={environmentId} />
      <HubDeviceListSection
        environmentId={environmentId}
        hosts={hosts}
        snapshot={snapshot}
        hostsState={
          result._tag === "Initial" ? "reading" : result._tag === "Failure" ? "failed" : "read"
        }
        refreshing={result.waiting}
        reachesHosts={reachesHosts}
        actions={actions}
        onRefresh={() => registry.refresh(atom)}
      />
    </>
  );
}
