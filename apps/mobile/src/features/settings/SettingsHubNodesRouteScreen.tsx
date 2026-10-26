import { useAtomValue } from "@effect/atom-react";
import {
  cloudAutoJoinSaveError,
  hubDeviceList,
  type ChildSetup,
} from "@goat/client-runtime/hub-devices";
import {
  canRemoveHubNode,
  HUB_NODE_IMPORT_NOTICE,
  hubNodeLastSeenLabel,
  hubNodeRemovalInput,
  hubNodeRouteLabel,
  hubNodeStatusLabel,
  isHubNodesUnsupportedError,
} from "@goat/client-runtime/hub-nodes";
import {
  HUB_TRANSPORT_LABEL,
  hubDeviceFacts,
  hubSnapshot,
} from "@goat/client-runtime/state/hub-fleet";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId } from "@goat/contracts";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsHubNodesRouteScreen() {
  const { selectedTargets, selectedIds } = useSettingsEnvironmentFilter();
  const { environments } = useEnvironments();
  const targets = environments.filter(
    (target) => selectedIds === null || selectedIds.has(target.environmentId),
  );
  return (
    <SettingsScreen title="Hub devices">
      <HubNodesSelection
        key={JSON.stringify(selectedIds === null ? null : [...selectedIds].sort())}
        targets={targets}
        connectedTargets={selectedTargets}
      />
    </SettingsScreen>
  );
}

function HubNodesSelection({
  targets,
  connectedTargets,
}: {
  readonly targets: readonly Pick<EnvironmentPresentation, "environmentId" | "label">[];
  readonly connectedTargets: readonly Pick<EnvironmentPresentation, "environmentId" | "label">[];
}) {
  // Retain the choice across disconnects; only an explicit Settings filter change resets it.
  const [choice, setChoice] = useState(() => (targets.length === 1 ? targets[0]! : null));
  const hub = connectedTargets.find((target) => target.environmentId === choice?.environmentId);
  const label =
    targets.find((target) => target.environmentId === choice?.environmentId)?.label ??
    choice?.label;
  return (
    // One scroll container: the header inset applies to the chooser, and a long chooser scrolls
    // with the devices instead of crowding them out.
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1"
      contentContainerClassName="gap-4 p-5 pb-10"
    >
      {targets.length > 1 ||
      (targets.length === 1 && targets[0]?.environmentId !== choice?.environmentId) ? (
        <View className="gap-2">
          <Text className="text-sm text-foreground-muted">Choose a hub</Text>
          {targets.map((target) => {
            const state = connectedTargets.some(
              (connected) => connected.environmentId === target.environmentId,
            )
              ? "Connected"
              : "Not connected";
            return (
              <Pressable
                key={target.environmentId}
                accessibilityRole="radio"
                accessibilityLabel={`Use hub ${target.label}, ${state.toLowerCase()}`}
                accessibilityState={{ checked: target.environmentId === choice?.environmentId }}
                onPress={() => setChoice(target)}
                className="min-h-12 justify-center rounded-xl bg-grouped-card px-4 py-2"
              >
                <Text className="text-foreground">{target.label}</Text>
                <Text className="text-sm text-foreground-muted">{state}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {choice ? <Text className="font-goat-medium text-foreground">Hub: {label}</Text> : null}
      {hub ? (
        <HubDevicesList
          key={hub.environmentId}
          environmentId={hub.environmentId}
          label={label ?? hub.label}
        />
      ) : (
        <Text className="text-foreground-muted">
          {choice
            ? `${label} is disconnected. Reconnect to manage its devices.`
            : targets.length > 0
              ? "Choose a hub to see its devices."
              : "Select a connected hub in Settings to see its devices."}
        </Text>
      )}
    </ScrollView>
  );
}

const CHILD_SETUP_TEXT: Record<ChildSetup["tone"], string> = {
  progress: "text-sm text-foreground-muted",
  warning: "text-sm text-warning-foreground",
  destructive: "text-sm text-danger-foreground",
};

/** Web's host-status period: each read samples CPU and asks every SSH host. */
const SETUP_REFRESH_MS = 15_000;

/** The hub's machines with their OpenCodex link, as Settings → Hub shows them on desktop and web. */
function HubDevicesList({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const listed = useEnvironmentQuery(serverEnvironment.hubNodesLive({ environmentId, input: {} }));
  const status = useEnvironmentQuery(serverEnvironment.hostStatus({ environmentId, input: {} }));
  const { environments } = useEnvironments();
  const hubSettings =
    environments.find((entry) => entry.environmentId === environmentId)?.serverConfig?.settings
      .hub ?? null;
  const hosts = status.data?.hosts ?? [];
  const unsupported = isHubNodesUnsupportedError(listed.cause);
  const rows = hubDeviceList({
    nodes: listed.data?.nodes ?? null,
    snapshot: hubSnapshot(
      hosts.map((entry) => ({ key: entry.host ?? "", label: entry.host ?? label, entry })),
    ),
    hosts,
  });
  // Host status is a one-shot read; reread it only while a setup is still moving.
  const settingUp = rows.some((row) => row.childSetup?.state === "running");
  const refreshStatus = status.refresh;
  useEffect(() => {
    if (!settingUp) return;
    const timer = setInterval(refreshStatus, SETUP_REFRESH_MS);
    return () => clearInterval(timer);
  }, [settingUp, refreshStatus]);
  const canCheck = useAtomValue(serverEnvironment.checkHubNodes.permissionAtom(environmentId));
  const canRemove = useAtomValue(serverEnvironment.removeHubNode.permissionAtom(environmentId));
  const canDismiss = useAtomValue(
    serverEnvironment.dismissHubNodeNotice.permissionAtom(environmentId),
  );
  const check = useAtomCommand(serverEnvironment.checkHubNodes, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.removeHubNode, { reportFailure: false });
  const dismiss = useAtomCommand(serverEnvironment.dismissHubNodeNotice, { reportFailure: false });
  const canConfigure = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const canOptIn = useAtomValue(
    serverEnvironment.setHubDeviceChildOptIn.permissionAtom(environmentId),
  );
  const setOptIn = useAtomCommand(serverEnvironment.setHubDeviceChildOptIn, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const run = async (key: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (busy !== null) return;
    setBusy(key);
    setError(null);
    const result = await action();
    setBusy(null);
    setNow(Date.now());
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The hub request failed.");
    }
  };
  const linkKnown = status.isSuccess;
  // An older hub drops the field and answers on, since it always joins its cloud machines.
  const saveCloudAutoJoin = (autoJoinCloudMachines: boolean) =>
    void run("cloud-auto-join", async () => {
      const result = await updateSettings({
        environmentId,
        input: { patch: { hub: { autoJoinCloudMachines } } },
      });
      if (result._tag === "Success")
        setError(
          cloudAutoJoinSaveError(autoJoinCloudMachines, result.value.hub.autoJoinCloudMachines),
        );
      return result;
    });
  return (
    <View className="gap-4">
      <Text className="text-sm text-foreground-muted">
        Add devices from the hub's Settings on desktop or web.
      </Text>
      {hubSettings === null ? null : (
        <View className="flex-row items-center gap-3 rounded-xl bg-grouped-card p-4">
          <View className="flex-1 gap-1">
            <Text className="text-foreground">Join new cloud machines</Text>
            <Text className="text-sm text-foreground-muted">
              A cloud machine this hub creates gets its OpenCodex and joins as a Child the first
              time it is used. Off: new machines stay standalone, and linked ones stay linked.
            </Text>
          </View>
          <ThemedSwitch
            accessibilityLabel="Join new cloud machines"
            value={hubSettings.autoJoinCloudMachines}
            disabled={!canConfigure || !hubSettings.enabled || busy !== null}
            onValueChange={saveCloudAutoJoin}
          />
        </View>
      )}
      {unsupported ? (
        <Text className="text-sm text-foreground-muted">
          This hub runs an older GOAT without a device list. Update GOAT on the hub to manage its
          devices here.
        </Text>
      ) : (
        <Button
          label={busy === "check-all" ? "Checking…" : "Check all"}
          disabled={!canCheck || busy !== null || listed.data === null}
          onPress={() => {
            // Checking reaches each machine, so read its OpenCodex link again too.
            status.refresh();
            void run("check-all", () => check({ environmentId, input: {} }));
          }}
        />
      )}
      {error || (listed.error && !unsupported) ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error ?? listed.error}
        </Text>
      ) : null}
      {status.error ? (
        <View className="gap-2">
          <Text className="text-sm text-foreground-muted">
            Could not read OpenCodex link state. {status.error}
          </Text>
          <Button label="Try again" disabled={status.isPending} onPress={status.refresh} />
        </View>
      ) : null}
      {listed.data?.notices.map((notice) => (
        <View key={notice.id} className="gap-3 rounded-xl bg-grouped-card p-4">
          <Text className="text-sm text-foreground">{HUB_NODE_IMPORT_NOTICE}</Text>
          <Button
            label="Dismiss"
            disabled={!canDismiss || busy !== null}
            onPress={() =>
              void run("dismiss", () => dismiss({ environmentId, input: { id: notice.id } }))
            }
          />
        </View>
      ))}
      {rows.length === 0 ? (
        <Text className="text-foreground-muted">
          {listed.data === null && !listed.error ? "Loading devices…" : "No devices added yet."}
        </Text>
      ) : null}
      {rows.map(({ key, label: rowLabel, node, device, childSetup, childOptIn }) => {
        const link =
          device !== null
            ? HUB_TRANSPORT_LABEL[device.transport]
            : linkKnown
              ? "Not linked to OpenCodex"
              : null;
        return (
          <View key={key} className="gap-2 rounded-xl bg-grouped-card p-4">
            <Text className="font-goat-medium text-foreground">{rowLabel}</Text>
            {link === null ? null : <Text className="text-sm text-foreground-muted">{link}</Text>}
            {node === null ? null : (
              <>
                <Text className="text-sm text-foreground-muted">
                  {node.routes.map(hubNodeRouteLabel).join(" · ")}
                </Text>
                <View className="flex-row items-center gap-2">
                  <View
                    accessible={false}
                    className={
                      node.status === "online"
                        ? "size-2 rounded-full bg-primary"
                        : node.status === "offline"
                          ? "size-2 rounded-full bg-danger"
                          : "size-2 rounded-full bg-subtle-strong"
                    }
                  />
                  <Text className="text-sm text-foreground-muted">
                    {hubNodeStatusLabel(node.status)}
                    {node.lastSeenAt ? ` · ${hubNodeLastSeenLabel(node.lastSeenAt, now)}` : ""}
                  </Text>
                </View>
              </>
            )}
            {device === null ? null : (
              <Text className="text-sm text-foreground-muted">
                {hubDeviceFacts(device).join(" · ")}
              </Text>
            )}
            {childSetup === null ? null : (
              <View className="gap-1">
                <Text className={CHILD_SETUP_TEXT[childSetup.tone]}>{childSetup.label}</Text>
                {childSetup.detail === null ? null : (
                  <Text className="text-sm text-foreground-muted">{childSetup.detail}</Text>
                )}
              </View>
            )}
            {childOptIn === null ? null : (
              <View className="flex-row items-center gap-3">
                <View className="flex-1 gap-1">
                  <Text className="text-sm text-foreground">
                    Join as OpenCodex Child after each SSH setup
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    Turning this off keeps an existing link.
                  </Text>
                </View>
                <ThemedSwitch
                  accessibilityLabel={`Join ${rowLabel} as OpenCodex Child after each SSH setup`}
                  value={childOptIn.enabled}
                  disabled={!canOptIn || busy !== null}
                  onValueChange={(enabled) =>
                    void run(`opt-in:${childOptIn.host}`, async () => {
                      const result = await setOptIn({
                        environmentId,
                        input: { deviceAlias: childOptIn.host, enabled },
                      });
                      status.refresh();
                      return result;
                    })
                  }
                />
              </View>
            )}
            {node === null ? null : (
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label={busy === node.nodeId ? "Checking…" : "Check"}
                  accessibilityLabel={`Check ${node.label}`}
                  disabled={!canCheck || busy !== null}
                  onPress={() =>
                    void run(node.nodeId, () =>
                      check({ environmentId, input: { nodeId: node.nodeId } }),
                    )
                  }
                />
                {canRemove && canRemoveHubNode(node) ? (
                  <Button
                    label="Remove"
                    accessibilityLabel={`Remove ${node.label}`}
                    tone="danger"
                    disabled={busy !== null}
                    onPress={() =>
                      void run(`remove:${node.nodeId}`, () =>
                        remove({ environmentId, input: hubNodeRemovalInput(node) }),
                      )
                    }
                  />
                ) : null}
              </View>
            )}
            {node !== null && !canRemoveHubNode(node) ? (
              <Text className="text-sm text-foreground-muted">
                Manage cloud machines from the hub's Settings on desktop or web.
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
