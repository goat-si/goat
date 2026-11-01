import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  MemoryOperationId,
  MemoryHubEndpoint,
  supportsMemoryProtocol,
  type MemoryHubSettingsUpdateInput,
  type MemoryHubSettingsView,
  type MemoryOwnerSourceReadPolicyView,
  type MemorySyncStatus,
} from "@goat/contracts";
import {
  presentMemoryOwnerPolicy,
  presentMemorySync,
} from "@goat/client-runtime/memory-presentation";
import { memoryDeviceFlow } from "@goat/client-runtime/memory-device-flow";
import { useContext, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback } from "react";
import { AppState, View, TextInput } from "react-native";
import * as Crypto from "expo-crypto";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { memoryEnvironment as memory } from "../../state/memory";
import { environmentSession } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import {
  useSavedRemoteConnections,
  useRemoteConnectionStatus,
} from "../../state/use-remote-environment-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { toggleMemoryRequester } from "./SettingsMemoryRouteScreen.logic";
const Copy = ({ children }: { children: React.ReactNode }) => (
  <Text className="p-3 text-sm text-foreground-muted">{children}</Text>
);
const Action = (props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "danger";
}) => <SettingsActionRow icon="brain" {...props} />;
const decodeHubAddress = Schema.decodeUnknownSync(MemoryHubEndpoint);
const loopbackAddress = (value: string) => {
  try {
    const host = new URL(value).hostname;
    return /^(127\.|(?:.*\.)?localhost\.?$)/i.test(host) || host === "[::1]";
  } catch {
    return false;
  }
};
const versionConflict = (cause: Cause.Cause<unknown>) => {
  const failure = Option.getOrNull(Cause.findErrorOption(cause));
  return (
    typeof failure === "object" &&
    failure !== null &&
    "code" in failure &&
    failure.code === "revision_changed"
  );
};
const operationId = () => MemoryOperationId.make(Crypto.randomUUID());

export function MemoryAdministration({
  environmentId,
  onSharingRefresh,
  sync,
}: {
  environmentId: EnvironmentId;
  onSharingRefresh?: () => void;
  sync?: MemorySyncStatus | null;
}) {
  const registry = useContext(RegistryContext);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const environments = Object.values(savedConnectionsById).map((e) => ({
    environmentId: e.environmentId,
    label: e.environmentLabel,
  }));
  const readPreparedConnection = (id: EnvironmentId) =>
    Option.getOrNull(registry.get(environmentSession.preparedConnectionValueAtom(id)));
  const connection = Option.getOrNull(
    useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  const getHub = useAtomCommand(memory.hubSettingsGet, { reportFailure: false });
  const updateHub = useAtomCommand(memory.hubSettingsUpdate, {
    reportFailure: false,
    reportDefect: false,
  });
  const getOwner = useAtomCommand(memory.ownerSourceReadPolicyGet, {
    reportFailure: false,
  });
  const updateOwner = useAtomCommand(memory.ownerSourceReadPolicyUpdate, {
    reportFailure: false,
  });
  const canHub = useAtomValue(memory.hubSettingsUpdate.permissionAtom(environmentId));
  const canOwner = useAtomValue(memory.ownerSourceReadPolicyUpdate.permissionAtom(environmentId));
  const [hub, setHub] = useState<MemoryHubSettingsView | null>(null);
  const [owner, setOwner] = useState<MemoryOwnerSourceReadPolicyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<"hub" | "owner" | "device" | null>(null);
  const [device, setDevice] = useState<EnvironmentId | null>(null);
  const selectedConnection = Option.getOrNull(
    useAtomValue(environmentSession.preparedConnectionValueAtom(device ?? environmentId)),
  );

  const [endpoint, setEndpoint] = useState(connection?.httpBaseUrl ?? "");
  const [confirm, setConfirm] = useState<"disable" | "add" | "rotate" | EnvironmentId | null>(null);
  const members = hub?.members ?? [];
  const knownMembers = new Set(members.map((member) => member.environmentId));
  const intent = useRef<MemoryHubSettingsUpdateInput | null>(null);
  const ownerIntent = useRef<Parameters<typeof updateOwner>[0]["input"] | null>(null);
  const flow = useRef<ReturnType<typeof memoryDeviceFlow> | null>(null);
  const mounted = useRef(true);
  const loadGeneration = useRef(0);
  const deviceAttempt = useRef<{
    connection: object;
    deviceId: EnvironmentId;
    generation: number;
  } | null>(null);
  const attemptGeneration = useRef(0);
  const [recovery, setRecovery] = useState(false);
  function recover(message: string) {
    attemptGeneration.current += 1;
    loadGeneration.current += 1;
    deviceAttempt.current = null;
    flow.current?.dispose();
    flow.current = null;
    intent.current = null;
    ownerIntent.current = null;
    setPending(null);
    setBusy(false);
    setConfirm(null);
    setRecovery(true);
    setError(message);
  }
  useEffect(() => {
    const attempt = deviceAttempt.current;
    if (
      attempt &&
      (selectedConnection !== attempt.connection ||
        readPreparedConnection(attempt.deviceId) !== attempt.connection)
    ) {
      recover(
        "Device connection changed. Setup may be incomplete. Review the latest devices, then Replace key to recover or Remove to clean up.",
      );
    }
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flow.current?.dispose();
      flow.current = null;
    };
  }, []);
  const name = (id: EnvironmentId) =>
    environments.find((e) => e.environmentId === id)?.label ?? "Unknown device";
  const live = () =>
    mounted.current && connection !== null && readPreparedConnection(environmentId) === connection;
  const writable = (id: EnvironmentId) => registry.get(memory.hubSettingsUpdate.permissionAtom(id));
  const candidates = environments.filter(
    (e) =>
      e.environmentId !== environmentId &&
      connectedEnvironments.some(
        (c) =>
          c.environmentId === e.environmentId && c.isEnabled && c.connectionState === "connected",
      ) &&
      registry.get(serverEnvironment.configValueAtom(e.environmentId)) !== null &&
      supportsMemoryProtocol(
        registry.get(serverEnvironment.configValueAtom(e.environmentId))!.environment.capabilities,
      ),
  );
  const focusedOnce = useRef(false);
  const refreshBlocked = useRef(false);
  useEffect(() => {
    refreshBlocked.current = busy || pending !== null || recovery;
  }, [busy, pending, recovery]);
  useFocusEffect(
    useCallback(() => {
      const refresh = () => {
        if (refreshBlocked.current || intent.current || ownerIntent.current || flow.current) return;
        setReload((value) => value + 1);
      };
      if (focusedOnce.current) refresh();
      focusedOnce.current = true;
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
      return () => {
        loadGeneration.current += 1;
        subscription.remove();
      };
    }, []),
  );
  useEffect(() => {
    let current = true;
    const generation = ++loadGeneration.current;
    // Synchronize the connected device settings when the explicit reload changes.
    void (async () => {
      const result = await getHub({ environmentId, input: {} });
      if (!current || generation !== loadGeneration.current) return;
      if (result._tag === "Success") setHub(result.value);
      else setError("Could not load sharing settings.");
      if (registry.get(memory.ownerSourceReadPolicyGet.permissionAtom(environmentId))) {
        const policy = await getOwner({ environmentId, input: {} });
        if (!current || generation !== loadGeneration.current) return;
        if (policy._tag === "Success") setOwner(policy.value);
        else setError("Could not load original conversation access.");
      }
    })();
    return () => {
      current = false;
    };
    // Explicit reload starts a new settings read even when the connection is unchanged.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [environmentId, getHub, getOwner, registry, reload]);
  async function saveHub(input: MemoryHubSettingsUpdateInput) {
    if (busy || !live() || !writable(environmentId)) return;
    loadGeneration.current += 1;
    intent.current = input;
    setPending("hub");
    setBusy(true);
    setError(null);
    const result = await updateHub({ environmentId, input });
    if (!live()) return;
    setBusy(false);
    if (result._tag === "Failure") {
      if (versionConflict(result.cause)) {
        recover(
          "Sharing changed on another device. Review the latest settings before trying again.",
        );
        return;
      }
      setError("Sharing update failed. Retry to continue the same request.");
      return;
    }
    intent.current = null;
    setPending(null);
    setHub(result.value.view);
    setConfirm(null);
    onSharingRefresh?.();
  }
  async function saveOwner(id: EnvironmentId) {
    if (
      !owner ||
      busy ||
      !live() ||
      !registry.get(memory.ownerSourceReadPolicyUpdate.permissionAtom(environmentId))
    )
      return;
    const input = ownerIntent.current ?? {
      requestId: operationId(),
      expectedVersion: owner.version,
      allowedRequesterEnvironmentIds: toggleMemoryRequester(owner, id),
    };
    loadGeneration.current += 1;
    ownerIntent.current = input;
    setPending("owner");
    setBusy(true);
    setError(null);
    const result = await updateOwner({ environmentId, input });
    if (!live()) return;
    setBusy(false);
    if (result._tag === "Success") {
      setOwner(result.value);
      ownerIntent.current = null;
      setPending(null);
    } else if (versionConflict(result.cause)) {
      recover(
        "Conversation access changed on another device. Review the latest settings before trying again.",
      );
    } else setError("Could not update access. Retry to continue the same request.");
  }
  async function addDevice(action: "provisionMember" | "rotateMemberCredential") {
    if (
      !hub ||
      !device ||
      busy ||
      recovery ||
      !live() ||
      !writable(environmentId) ||
      !writable(device)
    )
      return;
    if (!readPreparedConnection(device)) {
      setError("Connect the device in Settings → Connections first.");
      return;
    }
    try {
      decodeHubAddress(endpoint);
    } catch {
      setError("Enter a valid Hub address using HTTPS, or HTTP for localhost.");
      return;
    }
    if (loopbackAddress(endpoint)) {
      setError(
        "Localhost points to the device itself. Enter a hub address reachable from the other device.",
      );
      return;
    }
    loadGeneration.current += 1;
    setBusy(true);
    setError(null);
    const generation = attemptGeneration.current;
    try {
      if (!flow.current) {
        const deviceConnection = readPreparedConnection(device)!;
        deviceAttempt.current = { connection: deviceConnection, deviceId: device, generation };
        const target = await getHub({ environmentId: device, input: {} });
        if (!live() || generation !== attemptGeneration.current) return;
        if (readPreparedConnection(device) !== deviceConnection) {
          recover(
            "Device connection changed. Review the latest devices before setting it up again.",
          );
          return;
        }
        if (target._tag === "Failure") throw new Error();
        const selected = device;
        setPending("device");
        flow.current = memoryDeviceFlow({
          hubId: environmentId,
          deviceId: selected,
          endpoint,
          hubVersion: hub.version,
          deviceVersion: target.value.version,
          action,
          requestIds: [operationId(), operationId(), operationId()],
          isActive: () =>
            live() &&
            readPreparedConnection(selected) === deviceConnection &&
            writable(environmentId) &&
            writable(selected),
          update: async (id, input) => {
            if (!live() || !writable(id) || !readPreparedConnection(id)) throw new Error();
            const result = await updateHub({ environmentId: id, input });
            if (result._tag === "Failure") {
              if (versionConflict(result.cause)) throw new Error("revision_changed");
              const failure = Option.getOrNull(Cause.findErrorOption(result.cause));
              throw failure ?? new Error("Request failed");
            }
            return result.value;
          },
        });
      }
      const view = await flow.current.run();
      if (!live() || generation !== attemptGeneration.current) return;
      deviceAttempt.current = null;
      setHub(view);
      flow.current.dispose();
      flow.current = null;
      setPending(null);
      setConfirm(null);
      setDevice(null);
      onSharingRefresh?.();
    } catch (failure) {
      if (generation !== attemptGeneration.current) return;
      const attempt = deviceAttempt.current;
      if (attempt && readPreparedConnection(attempt.deviceId) !== attempt.connection) {
        recover(
          "Device connection changed. Setup may be incomplete. Review the latest devices, then Replace key to recover or Remove to clean up.",
        );
        return;
      }
      if (
        typeof failure === "object" &&
        failure !== null &&
        "code" in failure &&
        failure.code === "capacity_exceeded" &&
        "capacity" in failure &&
        typeof failure.capacity === "object" &&
        failure.capacity !== null &&
        "dimension" in failure.capacity &&
        failure.capacity.dimension === "members"
      ) {
        recover("Device limit reached. Remove a device to add another.");
        return;
      }
      if (failure instanceof Error && failure.message === "revision_changed") {
        recover(
          "Device settings changed during setup. Setup may be incomplete. Review the latest devices, then Replace key to recover or Remove to clean up.",
        );
        return;
      }
      if (live())
        setError(
          "Device setup did not finish. Retry to continue. If you reload, use Replace key on the device row to recover, or Remove to clean up.",
        );
    } finally {
      if (live() && generation === attemptGeneration.current) setBusy(false);
    }
  }
  const policy = owner ? presentMemoryOwnerPolicy(owner) : null;
  const blocked = busy || !canHub || pending !== null || recovery;
  const retry = () => {
    if (recovery) {
      setRecovery(false);
      setHub(null);
      setOwner(null);
      setError(null);
      setReload((n) => n + 1);
      onSharingRefresh?.();
    } else if (flow.current)
      void addDevice(confirm === "rotate" ? "rotateMemberCredential" : "provisionMember");
    else if (intent.current) void saveHub(intent.current);
    else if (ownerIntent.current) void saveOwner(environmentId);
    else setReload((n) => n + 1);
  };
  return (
    <>
      <SettingsSection title="Sharing">
        <Copy>
          {!hub
            ? error
              ? "Sharing unavailable"
              : "Loading sharing…"
            : hub.settings.mode === "hub"
              ? "This device is the hub"
              : hub.settings.mode === "member"
                ? `Shares memory with ${name(hub.settings.hubEnvironmentId)}`
                : "Memory off"}
        </Copy>
        {hub?.settings.mode === "hub" ? <Copy>Memory is on.</Copy> : null}
        {sync && hub && hub.settings.mode !== "disabled" ? (
          <Copy>{presentMemorySync(sync).label}</Copy>
        ) : null}
        {hub ? (
          hub.settings.mode === "disabled" ? (
            <Action
              label="Make this device the hub"
              disabled={blocked}
              onPress={() =>
                void saveHub({
                  action: "configure",
                  requestId: operationId(),
                  expectedVersion: hub.version,
                  settings: { mode: "hub", memorySpaceId: null },
                })
              }
            />
          ) : (
            <Action
              label="Turn sharing off"
              disabled={blocked}
              onPress={() => setConfirm("disable")}
            />
          )
        ) : null}
        {confirm === "disable" && hub ? (
          <View>
            <Copy>Stop sharing on this device?</Copy>
            <Copy>Saved memories stay.</Copy>
            <Action
              label="Stop sharing"
              disabled={blocked}
              onPress={() =>
                void saveHub({
                  action: "configure",
                  requestId: operationId(),
                  expectedVersion: hub.version,
                  settings: { mode: "disabled" },
                })
              }
            />
            <Action
              label="Cancel"
              disabled={busy || pending !== null}
              onPress={() => setConfirm(null)}
            />
          </View>
        ) : null}
        {error ? (
          <>
            <Copy>{error}</Copy>
            <Action
              label={recovery ? "Review latest settings" : "Retry"}
              disabled={busy}
              onPress={retry}
            />
            {pending !== null ? (
              <Action
                label="Stop retrying"
                disabled={busy}
                onPress={() =>
                  recover(
                    "Setup may be incomplete. Review the latest settings. Use Replace key to recover or Remove to clean up.",
                  )
                }
              />
            ) : null}
          </>
        ) : null}
      </SettingsSection>
      {hub?.settings.mode === "hub" ? (
        <SettingsSection title="Devices">
          {members
            .filter((m) => m.environmentId !== environmentId)
            .map((member) => {
              const id = member.environmentId;
              const connected = candidates.some((c) => c.environmentId === id);
              const reason = !connected
                ? "Connect this device in Settings → Connections to replace its key."
                : !writable(id)
                  ? "Settings write permission is required to replace this key."
                  : null;
              return (
                <View key={id}>
                  <Copy>{name(id)}</Copy>
                  {member.status === "pending_ack" ? (
                    <Copy>Waiting for the device to confirm</Copy>
                  ) : null}
                  {reason ? <Copy>{reason}</Copy> : null}
                  <Action
                    label={`Replace key for ${name(id)}`}
                    disabled={blocked || !!reason}
                    onPress={() => {
                      setDevice(id);
                      setConfirm("rotate");
                    }}
                  />
                  <Action
                    label={`Remove ${name(id)}`}
                    disabled={blocked}
                    onPress={() => setConfirm(id)}
                  />
                </View>
              );
            })}
          <Copy>Add device</Copy>
          <Copy>Choose a connected device that supports memory.</Copy>
          {candidates
            .filter((e) => !knownMembers.has(e.environmentId))
            .map((e) => (
              <Action
                key={e.environmentId}
                label={`Add ${e.label}`}
                disabled={blocked}
                onPress={() => {
                  setDevice(e.environmentId);
                  setConfirm("add");
                }}
              />
            ))}
          {!candidates.some((e) => !knownMembers.has(e.environmentId)) ? (
            <Copy>Connect another device in Settings → Connections first.</Copy>
          ) : null}
          {(confirm === "add" || confirm === "rotate") && device ? (
            <>
              <Copy>
                {confirm === "add" ? `Add ${name(device)}?` : `Replace key for ${name(device)}?`}
              </Copy>
              <Copy>Hub address</Copy>
              <TextInput
                accessibilityLabel="Hub address"
                value={endpoint}
                onChangeText={setEndpoint}
                editable={!blocked}
                autoCapitalize="none"
                autoCorrect={false}
                className="m-3 rounded-lg border border-border p-3 text-foreground"
              />
              <Copy>
                {loopbackAddress(endpoint)
                  ? "Localhost points to the device itself. Enter a hub address reachable from the other device."
                  : "Address the device uses to reach this hub. Check that the device can reach it; saving an address does not verify connectivity."}
              </Copy>
              {!writable(device) ? (
                <Copy>Settings write permission is required on this device.</Copy>
              ) : null}
              <Action
                label="Confirm"
                disabled={blocked || !writable(device) || loopbackAddress(endpoint)}
                onPress={() =>
                  void addDevice(
                    confirm === "rotate" ? "rotateMemberCredential" : "provisionMember",
                  )
                }
              />
              <Action
                label="Cancel"
                disabled={busy || pending !== null}
                onPress={() => setConfirm(null)}
              />
            </>
          ) : null}
          {confirm && confirm !== "disable" && confirm !== "add" && confirm !== "rotate" ? (
            <>
              <Copy>{`Remove ${name(confirm)}?`}</Copy>
              <Copy>This device will lose access to shared memory.</Copy>
              <Action
                label="Remove device"
                tone="danger"
                disabled={blocked}
                onPress={() =>
                  void saveHub({
                    action: "revokeMember",
                    requestId: operationId(),
                    expectedVersion: hub.version,
                    environmentId: confirm,
                  })
                }
              />
              <Action
                label="Cancel"
                disabled={busy || pending !== null}
                onPress={() => setConfirm(null)}
              />
            </>
          ) : null}
        </SettingsSection>
      ) : null}
      {hub && hub.settings.mode !== "disabled" ? (
        <SettingsSection title="Original conversations">
          <Copy>
            When a memory points to a conversation on this device, these devices can open the
            original. Removing a device applies to later requests and to results still on the hub.
          </Copy>
          {policy?.desiredRequesterEnvironmentIds.map((id) => (
            <View key={id}>
              <Copy>{name(id)}</Copy>
              {policy.pendingEnrollments.find((e) => e.requesterEnvironmentId === id) ? (
                <Copy>Waiting for the device to confirm</Copy>
              ) : null}
              <Action
                label={`Remove conversation access for ${name(id)}`}
                disabled={busy || recovery || !canOwner || pending !== null}
                onPress={() => void saveOwner(id)}
              />
            </View>
          ))}
          {owner?.policy.removals
            .filter(
              (r) =>
                r.state === "pending" &&
                !policy?.desiredRequesterEnvironmentIds.includes(r.requesterEnvironmentId),
            )
            .map((r) => (
              <Copy key={r.requesterEnvironmentId}>
                {name(r.requesterEnvironmentId)} · Removal pending
              </Copy>
            ))}
          {candidates
            .filter((e) => !policy?.desiredRequesterEnvironmentIds.includes(e.environmentId))
            .map((e) => (
              <Action
                key={e.environmentId}
                label={`Allow ${e.label}`}
                disabled={busy || recovery || !canOwner || !owner || pending !== null}
                onPress={() => void saveOwner(e.environmentId)}
              />
            ))}
          {!canOwner ? <Copy>Settings write permission is required.</Copy> : null}
        </SettingsSection>
      ) : null}
    </>
  );
}
