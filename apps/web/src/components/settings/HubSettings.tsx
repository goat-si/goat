import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  HUB_TRANSPORT_LABEL,
  hubParityLabel,
  hubReachabilityLabel,
  hubSnapshot,
  hubVersionLabel,
  type HubDevice,
  type HubSnapshot,
} from "@goat/client-runtime/state/hub-fleet";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  FLEET_LOCAL_HOST_KEY,
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
import { fleetEnvironmentsAtom } from "~/state/fleet";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { profileLabel } from "../desktop/firstRunPrompts.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AddHubDevice,
  HubActionResult,
  HubDeviceActionButtons,
  useHubActions,
  type HubActions,
} from "./HubDeviceActions";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const CLOUD_HOLDER_LABEL: Record<HubSettingsValue["cloudHolder"], string> = {
  hub: "On this hub",
  auto: "Wherever signed in",
};

const VERDICT_BADGE = {
  ok: "success",
  degraded: "warning",
  broken: "error",
  unproven: "outline",
} as const;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const GOATCLAW_HOST_STATE: Record<GoatclawHostSyncState, string> = {
  applied: "applied",
  pending: "waiting",
  outdated: "needs a GOAT update",
};
const GOATCLAW_HOST_ORDER: ReadonlyArray<GoatclawHostSyncState> = [
  "outdated",
  "pending",
  "applied",
];
const GOATCLAW_HOSTS_SHOWN = 2;

/** Where the policy has not landed comes first; the rest folds into +N, the full list into the tooltip. */
function goatclawFleetStatus(hosts: ReadonlyArray<HostStatusEntry>) {
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
    .map((row) => `${row.host} ${GOATCLAW_HOST_STATE[row.state]}`);
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
  reading: boolean,
  snapshot: HubSnapshot | null,
  home: OpenCodexInventorySnapshot | undefined,
) {
  if (reading) return "Reading OpenCodex…";
  const version = (value: string | null | undefined) =>
    value ? `OpenCodex ${value}` : "OpenCodex";
  if (snapshot !== null)
    return [
      `${version(snapshot.homeVersion)} Home`,
      snapshot.homeName,
      snapshot.homeHealthy ? null : "not answering",
    ]
      .filter((part) => part !== null)
      .join(" · ");
  return home?.installed
    ? `${version(home.runtime.version)} here is not a Home yet: it has no linked devices.`
    : "OpenCodex is not installed on this machine.";
}

export function HubSettings() {
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
        <SettingsSection id="hub" title="Hub">
          <SettingsRow
            {...searchableSetting("hub-enabled")}
            description="Connect an environment to choose whether it runs your fleet as the hub."
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function useHubSettings(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const settings = useEnvironmentSettings(environmentId, (value) => value.hub);
  const goatclaw = useEnvironmentSettings(environmentId, (value) => value.goatclaw);
  const canConfigure = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savePatch = async (
    patch:
      | { readonly hub: Partial<HubSettingsValue> }
      | { readonly goatclaw: Partial<Pick<GoatclawSettings, "enabled" | "defaultProfile">> },
  ) => {
    if (!registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId))) return;
    setSaving(true);
    setError(null);
    const result = await update({ environmentId, input: { patch } });
    setSaving(false);
    if (result._tag === "Failure") setError("Could not save the setting. Try again.");
  };
  return {
    settings,
    goatclaw,
    canConfigure,
    saving,
    error,
    save: (hub: Partial<HubSettingsValue>) => savePatch({ hub }),
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
  const registry = useContext(RegistryContext);
  const hub = useHubSettings(environmentId);
  const atom = hostStatusAtom(environmentId);
  const result = useAtomValue(atom);
  const reachesHosts = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [adding, setAdding] = useState(false);
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
  const homeStatus = homeStatusText(result._tag === "Initial", snapshot, home);
  const fleetGoatclaw = goatclawFleetStatus(hosts);
  const dashboard =
    local && home?.installed && (isElectron || LOOPBACK.has(window.location.hostname))
      ? `http://127.0.0.1:${home.runtime.port}/`
      : null;

  return (
    <>
      <SettingsSection id="hub" title="Hub">
        <SettingsRow
          {...searchableSetting("hub-enabled")}
          serverScoped
          settingKeys={["hub"]}
          description={`${label} checks every linked device's parity every 30 minutes and holds cloud runs. When a device cannot reach it, goal work there pauses and you get a decision. Devices and OpenCodex settings stay as they are.`}
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
              aria-label="This machine is the hub"
              checked={hub.settings.enabled}
              disabled={hub.saving || !hub.canConfigure}
              onCheckedChange={(enabled) => void hub.save({ enabled })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("hub-cloud-holder")}
          serverScoped
          settingKeys={["hub"]}
          description="Where Claude Cloud, Cursor Cloud and Devin Cloud runs start by default."
          control={
            <Select
              value={hub.settings.cloudHolder}
              disabled={hub.saving || !hub.canConfigure || !hub.settings.enabled}
              onValueChange={(value) => {
                if (value === "hub" || value === "auto") void hub.save({ cloudHolder: value });
              }}
            >
              <SelectTrigger size="sm" aria-label="Cloud runs">
                <SelectValue>
                  {(value: HubSettingsValue["cloudHolder"]) => CLOUD_HOLDER_LABEL[value]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {HubCloudHolder.literals.map((value) => (
                  <SelectItem key={value} value={value}>
                    {CLOUD_HOLDER_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("hub-permission-profiles")}
          serverScoped
          settingKeys={["goatclaw"]}
          description="Agents can launch, merge or change settings only as far as their profile allows. Agents without one get the default profile. Applies to every connected host: switching it here switches it there too."
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
              aria-label="Permission profiles"
              checked={hub.goatclaw.enabled}
              disabled={hub.saving || !hub.canConfigure}
              onCheckedChange={(enabled) => void hub.saveGoatclaw({ enabled })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("hub-default-profile")}
          serverScoped
          settingKeys={["goatclaw"]}
          description="The profile for agents launched without one."
          control={
            <Select
              value={hub.goatclaw.defaultProfile}
              disabled={hub.saving || !hub.canConfigure || !hub.goatclaw.enabled}
              onValueChange={(value) => {
                if (typeof value === "string") void hub.saveGoatclaw({ defaultProfile: value });
              }}
            >
              <SelectTrigger size="sm" aria-label="Default profile">
                <SelectValue>{(value: string) => profileLabel(value)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {Object.keys(hub.goatclaw.profiles).map((id) => (
                  <SelectItem key={id} value={id}>
                    {profileLabel(id)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {dashboard === null ? null : (
          <SettingsRow
            title="Accounts and keys"
            description="OpenCodex keeps every sign-in and key. GOAT never shows them."
            control={
              <Button
                size="xs"
                variant="outline"
                render={<a href={dashboard} target="_blank" rel="noreferrer" />}
              >
                Open OpenCodex
              </Button>
            }
          />
        )}
      </SettingsSection>
      <SettingsSection
        {...searchableSetting("hub-devices")}
        headerAction={
          <span className="flex items-center gap-1">
            <Button
              size="xs"
              variant="outline"
              disabled={adding || !actions.allowed}
              onClick={() => setAdding(true)}
            >
              Add device to hub
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={result.waiting}
              onClick={() => registry.refresh(atom)}
            >
              Refresh
            </Button>
          </span>
        }
      >
        {adding ? (
          <AddHubDevice
            actions={actions}
            suggestions={
              snapshot?.devices
                .filter((device) => device.transport === "standalone")
                .map((device) => device.alias) ?? []
            }
            onClose={() => setAdding(false)}
          />
        ) : null}
        <HubDevices
          environmentId={environmentId}
          snapshot={snapshot}
          reading={result._tag === "Initial"}
          failed={result._tag === "Failure"}
          reachesHosts={reachesHosts}
          actions={actions}
          onVerified={() => registry.refresh(atom)}
        />
      </SettingsSection>
    </>
  );
}

function HubDevices(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: HubSnapshot | null;
  readonly reading: boolean;
  readonly failed: boolean;
  readonly reachesHosts: boolean;
  readonly actions: HubActions;
  readonly onVerified: () => void;
}) {
  const message = props.reading
    ? "Reading devices…"
    : props.failed
      ? "Could not read devices. Try Refresh."
      : props.snapshot === null || props.snapshot.devices.length === 0
        ? "No devices yet. Add one with Add device to hub."
        : null;
  // A device that left the hub drops out of the list; its result stays readable here.
  const listed = new Set(props.snapshot?.devices.map((device) => device.alias) ?? []);
  const recent = props.actions.entries.filter((entry) => !listed.has(entry.alias));
  return (
    <>
      {message === null ? (
        <ul aria-label="Hub devices" className="divide-y divide-border/50">
          {props.snapshot!.devices.map((device) => (
            <HubDeviceRow
              key={device.alias}
              environmentId={props.environmentId}
              device={device}
              actions={props.actions}
              onVerified={props.onVerified}
            />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">{message}</p>
      )}
      {recent.length === 0 ? null : (
        <section aria-label="Recent actions" className="space-y-2 px-3 py-3 sm:px-4">
          <h3 className="text-xs font-medium text-muted-foreground">Recent actions</h3>
          {recent.map((entry) => (
            <HubActionResult key={entry.alias} entry={entry} actions={props.actions} />
          ))}
        </section>
      )}
      {props.reachesHosts ? null : (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          Device versions and checks show for sessions that can operate threads.
        </p>
      )}
    </>
  );
}

function HubDeviceRow({
  environmentId,
  device,
  actions,
  onVerified,
}: {
  readonly environmentId: EnvironmentId;
  readonly device: HubDevice;
  readonly actions: HubActions;
  readonly onVerified: () => void;
}) {
  const canVerify = useAtomValue(serverEnvironment.verifyHubDevice.permissionAtom(environmentId));
  const verify = useAtomCommand(serverEnvironment.verifyHubDevice, { reportFailure: false });
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parity = device.parity;
  const failing = parity?.checks.filter((check) => check.status === "failed") ?? [];
  const runVerify = async () => {
    setVerifying(true);
    setError(null);
    const result = await verify({ environmentId, input: { deviceAlias: device.alias } });
    setVerifying(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    onVerified();
  };
  return (
    <li data-hub-device={device.alias} className="space-y-2 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 truncate text-sm font-medium">{device.alias}</h3>
        <span className="text-xs text-muted-foreground">
          {HUB_TRANSPORT_LABEL[device.transport]}
        </span>
        <Badge size="sm" variant={parity === null ? "outline" : VERDICT_BADGE[parity.verdict]}>
          Parity {hubParityLabel(parity)}
        </Badge>
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          disabled={verifying || !canVerify}
          onClick={() => void runVerify()}
        >
          {verifying ? "Verifying…" : "Verify"}
        </Button>
        <HubDeviceActionButtons device={device} actions={actions} />
      </div>
      <p className="text-xs text-muted-foreground">
        {[
          hubVersionLabel(device),
          device.tunnel === null ? null : `tunnel ${device.tunnel}`,
          hubReachabilityLabel(device),
          parity === null
            ? "never verified"
            : `verified ${formatRelativeTimeLabel(new Date(parity.checkedAt).toISOString())}`,
        ]
          .filter((part) => part !== null)
          .join(" · ")}
      </p>
      {failing.length === 0 ? null : (
        <ul className="space-y-0.5 text-xs">
          {failing.map((check) => (
            <li key={check.id}>
              <span className="font-mono">{check.id}</span>{" "}
              <span className="text-muted-foreground">{check.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <HubActionResult entry={actions.entry(device.alias)} actions={actions} />
      <DeviceFallback alias={device.alias} fallback={device.fallback} />
    </li>
  );
}

/**
 * The hub-down policy runs on the device and reads that device's own `hub.devices.local`,
 * because the hub may be the machine that is down. So the switch writes through the device's
 * GOAT connection, matched by its SSH alias or name.
 */
function DeviceFallback({
  alias,
  fallback,
}: {
  readonly alias: string;
  readonly fallback: HubDevice["fallback"];
}) {
  const environments = useAtomValue(fleetEnvironmentsAtom);
  const device = environments.find(
    (environment) => environment.sshAliases.includes(alias) || environment.label === alias,
  );
  const id = `hub-fallback-${alias}`;
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="min-w-0 text-xs">
        Use this device's own sign-in when the hub is down
        <span className="block text-muted-foreground">
          {device === undefined
            ? `Connect to ${alias} in GOAT to change this; the setting lives on that device.`
            : `OpenCodex allows it: ${FALLBACK_LABEL[fallback]}`}
        </span>
      </label>
      {device === undefined ? (
        <Switch id={id} checked={false} disabled />
      ) : (
        <DeviceFallbackSwitch id={id} environmentId={device.environmentId} />
      )}
    </div>
  );
}

const FALLBACK_LABEL: Record<HubDevice["fallback"], string> = {
  on: "yes",
  off: "no",
  unknown: "unknown",
};

function DeviceFallbackSwitch({
  id,
  environmentId,
}: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
}) {
  const registry = useContext(RegistryContext);
  const devices = useEnvironmentSettings(environmentId, (value) => value.hub.devices);
  const canConfigure = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const save = async (localFallback: boolean) => {
    if (!registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId))) return;
    setSaving(true);
    setError(false);
    const result = await update({
      environmentId,
      input: {
        patch: { hub: { devices: { ...devices, [FLEET_LOCAL_HOST_KEY]: { localFallback } } } },
      },
    });
    setSaving(false);
    setError(result._tag === "Failure");
  };
  return (
    <span className="flex items-center gap-2">
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          Could not save
        </span>
      ) : null}
      <Switch
        id={id}
        checked={devices[FLEET_LOCAL_HOST_KEY]?.localFallback ?? false}
        disabled={saving || !canConfigure}
        onCheckedChange={(checked) => void save(checked)}
      />
    </span>
  );
}
