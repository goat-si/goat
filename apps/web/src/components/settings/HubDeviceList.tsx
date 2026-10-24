import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  hubDeviceList,
  type ChildSetup,
  type HubDeviceRow,
} from "@goat/client-runtime/hub-devices";
import {
  HUB_TRANSPORT_LABEL,
  hubParityLabel,
  hubReachabilityLabel,
  hubVersionLabel,
  type HubDevice,
  type HubSnapshot,
} from "@goat/client-runtime/state/hub-fleet";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { FLEET_LOCAL_HOST_KEY, type EnvironmentId, type HostStatusEntry } from "@goat/contracts";
import { useContext, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { fleetEnvironmentsAtom } from "~/state/fleet";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  AddHubDevice,
  HubActionResult,
  HubDeviceActionButtons,
  type HubActions,
} from "./HubDeviceActions";
import {
  HubNodeAddForms,
  HubNodeButtons,
  HubNodeFooter,
  HubNodeStatus,
  useHubNodes,
  type HubNodes,
} from "./HubNodesSettings";
import { SettingsSearchTarget, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const VERDICT_BADGE = {
  ok: "success",
  degraded: "warning",
  broken: "error",
  unproven: "outline",
} as const;

const CHILD_SETUP_TEXT: Record<ChildSetup["tone"], string> = {
  progress: "text-muted-foreground",
  warning: "text-warning-foreground",
  destructive: "text-destructive-foreground",
};

/**
 * Settings → Hub's one device list for the selected environment: the machines its hub reaches,
 * each with its OpenCodex link state, and the Home's progress making a cloud machine its Child.
 */
export function HubDeviceListSection(props: {
  readonly environmentId: EnvironmentId;
  readonly hosts: ReadonlyArray<HostStatusEntry>;
  readonly snapshot: HubSnapshot | null;
  readonly hostsState: "reading" | "failed" | "read";
  readonly refreshing: boolean;
  readonly reachesHosts: boolean;
  readonly actions: HubActions;
  readonly onRefresh: () => void;
}) {
  const nodes = useHubNodes(props.environmentId);
  const [adding, setAdding] = useState(false);
  const rows = hubDeviceList({
    nodes: nodes.value?.nodes ?? null,
    snapshot: props.snapshot,
    hosts: props.hosts,
  });
  const message =
    rows.length > 0
      ? null
      : props.hostsState === "reading" || nodes.loading
        ? "Reading devices…"
        : "No devices yet. Add an SSH host or GOAT server below, or join a machine to OpenCodex with Add device to hub.";
  // A device that left the hub drops out of the list; its result stays readable here.
  const listed = new Set(props.snapshot?.devices.map((device) => device.alias) ?? []);
  const recent = props.actions.entries.filter((entry) => !listed.has(entry.alias));
  return (
    <SettingsSection
      {...searchableSetting("hub-devices")}
      headerAction={
        <span className="flex items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={adding || !props.actions.allowed}
            onClick={() => setAdding(true)}
          >
            Add device to hub
          </Button>
          {nodes.unsupported ? null : (
            <Button
              size="xs"
              variant="outline"
              disabled={!nodes.canCheck || nodes.busy !== null || nodes.value === null}
              onClick={() => void nodes.checkAll()}
            >
              {nodes.busy === "check-all" ? "Checking…" : "Check all"}
            </Button>
          )}
          <Button size="xs" variant="ghost" disabled={props.refreshing} onClick={props.onRefresh}>
            Refresh
          </Button>
        </span>
      }
    >
      {adding ? (
        <AddHubDevice
          actions={props.actions}
          suggestions={
            props.snapshot?.devices
              .filter((device) => device.transport === "standalone")
              .map((device) => device.alias) ?? []
          }
          onClose={() => setAdding(false)}
        />
      ) : null}
      {message === null ? (
        <ul aria-label="Hub devices" className="divide-y divide-border/50">
          {rows.map((row) => (
            <HubDeviceListRow
              key={row.key}
              environmentId={props.environmentId}
              row={row}
              nodes={nodes}
              actions={props.actions}
              linkKnown={props.hostsState === "read"}
              onVerified={props.onRefresh}
            />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">{message}</p>
      )}
      {props.hostsState === "failed" ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          Could not read OpenCodex link state. Try Refresh.
        </p>
      ) : null}
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
      {/* Search and old links to "Devices on this hub" land on the forms that add one. */}
      <SettingsSearchTarget {...searchableSetting("hub-nodes")} className="outline-none">
        <HubNodeAddForms nodes={nodes} />
      </SettingsSearchTarget>
    </SettingsSection>
  );
}

function HubDeviceListRow({
  environmentId,
  row,
  nodes,
  actions,
  linkKnown,
  onVerified,
}: {
  readonly environmentId: EnvironmentId;
  readonly row: HubDeviceRow;
  readonly nodes: HubNodes;
  readonly actions: HubActions;
  /** Host status answered, so a machine without an OpenCodex device is known not to be linked. */
  readonly linkKnown: boolean;
  readonly onVerified: () => void;
}) {
  const canVerify = useAtomValue(serverEnvironment.verifyHubDevice.permissionAtom(environmentId));
  const verify = useAtomCommand(serverEnvironment.verifyHubDevice, { reportFailure: false });
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { node, device } = row;
  const parity = device?.parity ?? null;
  const failing = parity?.checks.filter((check) => check.status === "failed") ?? [];
  const linkLabel =
    device !== null
      ? HUB_TRANSPORT_LABEL[device.transport]
      : linkKnown
        ? "Not linked to OpenCodex"
        : null;
  const runVerify = async (alias: string) => {
    setVerifying(true);
    setError(null);
    const result = await verify({ environmentId, input: { deviceAlias: alias } });
    setVerifying(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    onVerified();
  };
  return (
    <li data-hub-device={row.label} className="space-y-2 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 truncate text-sm font-medium">{row.label}</h3>
        {linkLabel === null ? null : (
          <span className="text-xs text-muted-foreground">{linkLabel}</span>
        )}
        {device === null ? null : (
          <Badge size="sm" variant={parity === null ? "outline" : VERDICT_BADGE[parity.verdict]}>
            Parity {hubParityLabel(parity)}
          </Badge>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {node === null ? null : <HubNodeButtons nodes={nodes} node={node} />}
          {device === null ? null : (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={verifying || !canVerify}
                onClick={() => void runVerify(device.alias)}
              >
                {verifying ? "Verifying…" : "Verify"}
              </Button>
              <HubDeviceActionButtons device={device} actions={actions} />
            </>
          )}
        </span>
      </div>
      {node === null ? null : <HubNodeStatus node={node} now={nodes.now} />}
      {device === null ? null : (
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
      )}
      {row.childSetup === null ? null : <ChildSetupLine setup={row.childSetup} />}
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
      {device === null ? null : (
        <>
          <HubActionResult entry={actions.entry(device.alias)} actions={actions} />
          <DeviceFallback
            alias={device.alias}
            environmentId={node?.environmentId ?? null}
            fallback={device.fallback}
          />
        </>
      )}
      {node === null ? null : <HubNodeFooter nodes={nodes} node={node} />}
    </li>
  );
}

/** Shown until the machine is a Child: what setup is doing, or why it stopped. */
function ChildSetupLine({ setup }: { readonly setup: ChildSetup }) {
  return (
    <p role="status" className={cn("text-xs", CHILD_SETUP_TEXT[setup.tone])}>
      {setup.label} · {formatRelativeTimeLabel(new Date(setup.checkedAt).toISOString())}
      {setup.detail === null ? null : (
        <span className="block text-muted-foreground">{setup.detail}</span>
      )}
    </p>
  );
}

/**
 * The hub-down policy runs on the device and reads that device's own `hub.devices.local`,
 * because the hub may be the machine that is down. So the switch writes through the device's
 * GOAT connection: the hub node's own environment when it has one, else its SSH alias or name.
 */
function DeviceFallback({
  alias,
  environmentId,
  fallback,
}: {
  readonly alias: string;
  readonly environmentId: EnvironmentId | null;
  readonly fallback: HubDevice["fallback"];
}) {
  const environments = useAtomValue(fleetEnvironmentsAtom);
  const device =
    environments.find((environment) => environment.environmentId === environmentId) ??
    environments.find(
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
