import type {
  EnvironmentId,
  MemoryHubSettingsUpdateInput,
  MemoryHubSettingsUpdateResult,
  MemoryOperationId,
} from "@goat/contracts";

type Update = (
  environmentId: EnvironmentId,
  input: MemoryHubSettingsUpdateInput,
) => Promise<MemoryHubSettingsUpdateResult>;
/** One ephemeral attempt owns immutable requests. No credential enters React or persisted state. */
export function memoryDeviceFlow(options: {
  hubId: EnvironmentId;
  deviceId: EnvironmentId;
  endpoint: string;
  hubVersion: number;
  deviceVersion: number;
  action: "provisionMember" | "rotateMemberCredential";
  requestIds: readonly [MemoryOperationId, MemoryOperationId, MemoryOperationId];
  update: Update;
  isActive: () => boolean;
}) {
  let provision: MemoryHubSettingsUpdateResult | null = null;
  let installed = false;
  let disposed = false;
  const active = () => !disposed && options.isActive();
  return {
    dispose() {
      disposed = true;
      provision = null;
    },
    async run() {
      if (!active()) throw new Error("Device disconnected.");
      provision ??= await options.update(options.hubId, {
        action: options.action,
        environmentId: options.deviceId,
        requestId: options.requestIds[0],
        expectedVersion: options.hubVersion,
      });
      if (!active()) {
        provision = null;
        throw new Error("Device disconnected.");
      }
      const credential = provision.credential;
      if (!credential) throw new Error("Key unavailable. Replace the key or remove the device.");
      if (!installed) {
        await options.update(options.deviceId, {
          action: "installCredential",
          requestId: options.requestIds[1],
          expectedVersion: options.deviceVersion,
          hubEnvironmentId: options.hubId,
          endpoint: options.endpoint,
          memorySpaceId: credential.memorySpaceId,
          credential: credential.credential,
        });
        installed = true;
      }
      if (!active()) {
        provision = null;
        throw new Error("Device disconnected.");
      }
      const result = await options.update(options.hubId, {
        action: "acknowledgeCredential",
        requestId: options.requestIds[2],
        expectedVersion: provision.view.version,
        credentialRequestId: options.requestIds[0],
      });
      provision = null;
      return result.view;
    },
  };
}
