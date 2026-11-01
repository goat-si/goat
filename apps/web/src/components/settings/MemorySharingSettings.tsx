import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  MemoryOperationId,
  MemoryHubEndpoint,
  type MemoryHubSettingsUpdateInput,
  type MemoryHubSettingsView,
  type MemoryOwnerSourceReadPolicyView,
  type MemorySyncStatus,
} from "@goat/contracts";
import {
  presentMemoryOwnerPolicy,
  presentMemorySync,
} from "@goat/client-runtime/memory-presentation";
import { useContext, useEffect, useRef, useState } from "react";
import { useEnvironments } from "../../state/environments";
import { readPreparedConnection, usePreparedConnection } from "../../state/session";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { memoryEnvironment } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { isMemoryEnvironmentAvailable, memoryOwnerDesiredIds } from "./MemorySettings.logic";
import { memoryDeviceFlow } from "@goat/client-runtime/memory-device-flow";

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
const operationId = () => MemoryOperationId.make(randomUUID());

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
  const { environments } = useEnvironments();
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const getHub = useAtomCommand(memoryEnvironment.hubSettingsGet, { reportFailure: false });
  const updateHub = useAtomCommand(memoryEnvironment.hubSettingsUpdate, {
    reportFailure: false,
    reportDefect: false,
  });
  const getOwner = useAtomCommand(memoryEnvironment.ownerSourceReadPolicyGet, {
    reportFailure: false,
  });
  const updateOwner = useAtomCommand(memoryEnvironment.ownerSourceReadPolicyUpdate, {
    reportFailure: false,
  });
  const canHub = useAtomValue(memoryEnvironment.hubSettingsUpdate.permissionAtom(environmentId));
  const canOwner = useAtomValue(
    memoryEnvironment.ownerSourceReadPolicyUpdate.permissionAtom(environmentId),
  );
  const [hub, setHub] = useState<MemoryHubSettingsView | null>(null);
  const [owner, setOwner] = useState<MemoryOwnerSourceReadPolicyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<"hub" | "owner" | "device" | null>(null);
  const [device, setDevice] = useState<EnvironmentId | null>(null);
  const selectedConnection = Option.getOrNull(usePreparedConnection(device));
  const [requester, setRequester] = useState<EnvironmentId | null>(null);
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
  const writable = (id: EnvironmentId) =>
    registry.get(memoryEnvironment.hubSettingsUpdate.permissionAtom(id));
  const candidates = environments.filter(
    (e) =>
      e.environmentId !== environmentId &&
      e.connection.phase === "connected" &&
      isMemoryEnvironmentAvailable(e.serverConfig?.environment.capabilities),
  );
  // A newer load supersedes this one, and isCurrent ends it on unmount or a new environment.
  const loadSettings = (isCurrent: () => boolean) => {
    const generation = ++loadGeneration.current;
    void (async () => {
      const result = await getHub({ environmentId, input: {} });
      if (!isCurrent() || generation !== loadGeneration.current) return;
      if (result._tag === "Success") setHub(result.value);
      else setError("Could not load sharing settings.");
      if (registry.get(memoryEnvironment.ownerSourceReadPolicyGet.permissionAtom(environmentId))) {
        const policy = await getOwner({ environmentId, input: {} });
        if (!isCurrent() || generation !== loadGeneration.current) return;
        if (policy._tag === "Success") setOwner(policy.value);
        else setError("Could not load original conversation access.");
      }
    })();
  };
  const reloadSettings = () => {
    setError(null);
    loadSettings(() => mounted.current);
  };
  const [loadedEnvironmentId, setLoadedEnvironmentId] = useState(environmentId);
  if (loadedEnvironmentId !== environmentId) {
    setLoadedEnvironmentId(environmentId);
    setError(null);
  }
  useEffect(() => {
    let current = true;
    loadSettings(() => current);
    return () => {
      current = false;
    };
  }, [loadSettings]);
  useEffect(() => {
    const refresh = () => {
      if (pending !== null || busy || recovery) return;
      reloadSettings();
      onSharingRefresh?.();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [pending, busy, recovery, onSharingRefresh, reloadSettings]);
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
  async function saveOwner(id: EnvironmentId, allowed: boolean) {
    if (
      !owner ||
      busy ||
      !live() ||
      !registry.get(memoryEnvironment.ownerSourceReadPolicyUpdate.permissionAtom(environmentId))
    )
      return;
    const input = ownerIntent.current ?? {
      requestId: operationId(),
      expectedVersion: owner.version,
      allowedRequesterEnvironmentIds: memoryOwnerDesiredIds(owner, id, allowed),
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
      setRequester(null);
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
    // Promise handlers replace try/catch/finally, which the React Compiler cannot compile.
    const setUpDevice = async () => {
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
    };
    const onSetupFailure = (failure: unknown) => {
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
    };
    await setUpDevice()
      .catch(onSetupFailure)
      .finally(() => {
        if (live() && generation === attemptGeneration.current) setBusy(false);
      });
  }
  const policy = owner ? presentMemoryOwnerPolicy(owner) : null;
  function picker(
    value: EnvironmentId | null,
    onChange: (id: EnvironmentId | null) => void,
    ids: typeof candidates,
    label: string,
  ) {
    return (
      <Select value={value} onValueChange={onChange} disabled={busy || pending !== null}>
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder="Choose a device">{value ? name(value) : undefined}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {ids.map((e) => (
            <SelectItem key={e.environmentId} value={e.environmentId}>
              {e.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  }
  const blocked = busy || !canHub || pending !== null || recovery;
  return (
    <>
      <SettingsSection title="Sharing" id="memory-sharing">
        <SettingsRow
          title={
            !hub
              ? error
                ? "Sharing unavailable"
                : "Loading sharing"
              : hub.settings.mode === "hub"
                ? "This device is the hub"
                : hub?.settings.mode === "member"
                  ? "Memory sharing"
                  : "Sharing off"
          }
          description={
            !hub
              ? "Sharing settings are not loaded yet."
              : hub.settings.mode === "hub"
                ? "Memory is on. Devices you add here share memory with it."
                : hub?.settings.mode === "member"
                  ? `Shares memory with ${name(hub.settings.hubEnvironmentId)}.`
                  : "Sharing is off. Memory stays on this device. Make this device the hub, or add it from the hub's Memory settings."
          }
          status={
            sync && hub?.settings.mode !== "disabled" ? presentMemorySync(sync).label : undefined
          }
          control={
            hub ? (
              hub.settings.mode === "disabled" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  onClick={() =>
                    void saveHub({
                      action: "configure",
                      requestId: operationId(),
                      expectedVersion: hub.version,
                      settings: { mode: "hub", memorySpaceId: null },
                    })
                  }
                >
                  Make this device the hub
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  onClick={() => setConfirm("disable")}
                >
                  {hub.settings.mode === "member" ? "Leave sharing" : "Turn sharing off"}
                </Button>
              )
            ) : undefined
          }
        />
        {confirm === "disable" && hub ? (
          <SettingsRow
            title="Stop sharing on this device?"
            description="Saved memories stay."
            control={
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={blocked}
                  onClick={() =>
                    void saveHub({
                      action: "configure",
                      requestId: operationId(),
                      expectedVersion: hub.version,
                      settings: { mode: "disabled" },
                    })
                  }
                >
                  Stop sharing
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || pending !== null}
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </Button>
              </div>
            }
          />
        ) : null}
        {error ? (
          <SettingsRow
            title="Could not complete request"
            description={<span role="alert">{error}</span>}
            control={
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (recovery) {
                      setRecovery(false);
                      setHub(null);
                      setOwner(null);
                      reloadSettings();
                      onSharingRefresh?.();
                    } else if (flow.current)
                      void addDevice(
                        confirm === "rotate" ? "rotateMemberCredential" : "provisionMember",
                      );
                    else if (intent.current) void saveHub(intent.current);
                    else if (ownerIntent.current) void saveOwner(environmentId, true);
                    else {
                      reloadSettings();
                      onSharingRefresh?.();
                    }
                  }}
                >
                  {recovery ? "Review latest settings" : "Retry"}
                </Button>
                {pending !== null ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      recover(
                        "Setup may be incomplete. Review the latest settings. For a device, use Replace key to recover or Remove to clean up.",
                      )
                    }
                  >
                    Stop retrying
                  </Button>
                ) : null}
              </div>
            }
          />
        ) : null}
      </SettingsSection>
      {hub?.settings.mode === "hub" ? (
        <SettingsSection title="Devices">
          {members
            .filter((member) => member.environmentId !== environmentId)
            .map((member) => {
              const id = member.environmentId;
              const connected = candidates.some((candidate) => candidate.environmentId === id);
              const replaceReason = !connected
                ? "Connect this device in Settings → Connections to replace its key."
                : !writable(id)
                  ? "Settings write permission is required to replace this key."
                  : undefined;
              return (
                <SettingsRow
                  key={id}
                  title={name(id)}
                  status={
                    member.status === "pending_ack"
                      ? "Waiting for the device to confirm"
                      : undefined
                  }
                  description={replaceReason}
                  control={
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={blocked || Boolean(replaceReason)}
                        title={replaceReason}
                        onClick={() => {
                          setDevice(id);
                          setConfirm("rotate");
                        }}
                      >
                        Replace key
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={blocked}
                        onClick={() => setConfirm(id)}
                      >
                        Remove
                      </Button>
                    </div>
                  }
                />
              );
            })}
          <SettingsRow
            title="Add device"
            description="Choose a connected device that supports memory."
            control={
              <div className="flex flex-wrap gap-2">
                {picker(
                  device,
                  setDevice,
                  candidates.filter((e) => !knownMembers.has(e.environmentId)),
                  "Device",
                )}
                <Button
                  size="sm"
                  disabled={blocked || !device || knownMembers.has(device)}
                  onClick={() => setConfirm("add")}
                >
                  Add
                </Button>
              </div>
            }
          />
          {device && !writable(device) ? (
            <SettingsRow
              title="Settings write permission required on this device"
              description="Connect the device in Settings → Connections first, using an account with settings access."
            />
          ) : null}
          {(confirm === "add" || confirm === "rotate") && device ? (
            <SettingsRow
              title={
                confirm === "add" ? `Add ${name(device)}?` : `Replace key for ${name(device)}?`
              }
              description={
                loopbackAddress(endpoint)
                  ? "Localhost points to the device itself. Enter an address reachable from the other device."
                  : "Address the device uses to reach this hub. Check that the device can reach it; saving an address does not verify connectivity."
              }
              control={
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="memory-hub-address">Hub address</label>
                  <Input
                    id="memory-hub-address"
                    value={endpoint}
                    disabled={blocked}
                    onChange={(e) => setEndpoint(e.currentTarget.value)}
                  />
                  <Button
                    size="sm"
                    disabled={blocked || !writable(device) || loopbackAddress(endpoint)}
                    onClick={() =>
                      void addDevice(
                        confirm === "rotate" ? "rotateMemberCredential" : "provisionMember",
                      )
                    }
                  >
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || pending !== null}
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </Button>
                </div>
              }
            />
          ) : null}
          {confirm && confirm !== "disable" && confirm !== "add" && confirm !== "rotate" ? (
            <SettingsRow
              title={`Remove ${name(confirm)}?`}
              description="This device will lose access to shared memory."
              control={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={blocked}
                    onClick={() =>
                      void saveHub({
                        action: "revokeMember",
                        requestId: operationId(),
                        expectedVersion: hub.version,
                        environmentId: confirm,
                      })
                    }
                  >
                    Remove device
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || pending !== null}
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </Button>
                </div>
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}
      {hub && hub.settings.mode !== "disabled" ? (
        <SettingsSection title="Original conversations" id="memory-owner-policy">
          <SettingsRow
            title="Conversation access"
            description="When a memory points to a conversation on this device, these devices can open the original. Removing a device applies to later requests and to results still on the hub."
          />
          {policy?.desiredRequesterEnvironmentIds.map((id) => (
            <SettingsRow
              key={id}
              title={name(id)}
              status={policy.pendingEnrollments.find((e) => e.requesterEnvironmentId === id)?.label}
              control={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || recovery || !canOwner || pending !== null}
                  onClick={() => void saveOwner(id, false)}
                >
                  Remove
                </Button>
              }
            />
          ))}
          {owner?.policy.removals
            .filter(
              (r) =>
                r.state === "pending" &&
                !policy?.desiredRequesterEnvironmentIds.includes(r.requesterEnvironmentId),
            )
            .map((r) => (
              <SettingsRow
                key={r.requesterEnvironmentId}
                title={name(r.requesterEnvironmentId)}
                status="Removal pending"
              />
            ))}
          <SettingsRow
            title="Allow device"
            description={!canOwner ? "Settings write permission is required." : undefined}
            control={
              <div className="flex gap-2">
                {picker(
                  requester,
                  setRequester,
                  candidates.filter(
                    (e) => !policy?.desiredRequesterEnvironmentIds.includes(e.environmentId),
                  ),
                  "Conversation access device",
                )}
                <Button
                  size="sm"
                  disabled={
                    busy || recovery || !canOwner || !owner || !requester || pending !== null
                  }
                  onClick={() => requester && void saveOwner(requester, true)}
                >
                  Allow
                </Button>
              </div>
            }
          />
        </SettingsSection>
      ) : null}
    </>
  );
}
