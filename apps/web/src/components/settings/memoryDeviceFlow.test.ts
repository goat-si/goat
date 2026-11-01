import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  MemoryOperationId,
  MemorySpaceId,
  type MemoryHubSettingsUpdateInput,
  type MemoryHubSettingsUpdateResult,
} from "@goat/contracts";
import { memoryDeviceFlow } from "@goat/client-runtime/memory-device-flow";
const hub = EnvironmentId.make("hub");
const device = EnvironmentId.make("device");
const requestIds = [1, 2, 3].map((n) =>
  MemoryOperationId.make(`00000000-0000-4000-8000-00000000000${n}`),
) as [MemoryOperationId, MemoryOperationId, MemoryOperationId];
const result: MemoryHubSettingsUpdateResult = {
  view: {
    members: [],
    version: 5,
    settings: {
      mode: "hub",
      memorySpaceId: MemorySpaceId.make("00000000-0000-4000-8000-000000000009"),
    },
  },
  credential: {
    requestId: requestIds[0],
    environmentId: device,
    memorySpaceId: MemorySpaceId.make("00000000-0000-4000-8000-000000000009"),
    credentialVersion: 1,
    credential: "a".repeat(43),
  },
};
function options(
  update: (
    id: EnvironmentId,
    input: MemoryHubSettingsUpdateInput,
  ) => Promise<MemoryHubSettingsUpdateResult>,
) {
  return {
    hubId: hub,
    deviceId: device,
    hubVersion: 4,
    deviceVersion: 8,
    endpoint: "https://hub.example",
    action: "provisionMember" as const,
    requestIds,
    update,
    isActive: () => true,
  };
}
it.each(["provisionMember", "rotateMemberCredential"] as const)(
  "%s on the hub, installs on the member, then acknowledges on the hub",
  async (action) => {
    const update = vi.fn(async () => result);
    await memoryDeviceFlow({ ...options(update), action }).run();
    expect(update.mock.calls).toEqual([
      [
        hub,
        {
          action,
          environmentId: device,
          requestId: requestIds[0],
          expectedVersion: 4,
        },
      ],
      [
        device,
        {
          action: "installCredential",
          hubEnvironmentId: hub,
          endpoint: "https://hub.example",
          memorySpaceId: result.credential!.memorySpaceId,
          credential: result.credential!.credential,
          requestId: requestIds[1],
          expectedVersion: 8,
        },
      ],
      [
        hub,
        {
          action: "acknowledgeCredential",
          credentialRequestId: requestIds[0],
          requestId: requestIds[2],
          expectedVersion: 5,
        },
      ],
    ]);
  },
);
it.each(["provisionMember", "installCredential", "acknowledgeCredential"])(
  "retries %s with the same bytes and does not repeat completed stages",
  async (stage) => {
    let failed = false;
    const calls: { id: EnvironmentId; input: MemoryHubSettingsUpdateInput }[] = [];
    const flow = memoryDeviceFlow(
      options(async (id, input) => {
        calls.push({ id, input });
        if (input.action === stage && !failed) {
          failed = true;
          throw new Error("Lost response");
        }
        return result;
      }),
    );
    await expect(flow.run()).rejects.toThrow("Lost response");
    await flow.run();
    const retries = calls.filter((c) => c.input.action === stage);
    expect(retries).toHaveLength(2);
    expect(retries[0]).toEqual(retries[1]);
    expect(calls.map((c) => c.input.action)).toEqual([
      "provisionMember",
      ...(stage === "provisionMember" ? [stage] : []),
      "installCredential",
      ...(stage === "installCredential" ? [stage] : []),
      "acknowledgeCredential",
      ...(stage === "acknowledgeCredential" ? [stage] : []),
    ]);
  },
);
it("drops credentials on disposal and never continues after an unmount during provision", async () => {
  let release!: (value: MemoryHubSettingsUpdateResult) => void;
  const update = vi.fn(
    () =>
      new Promise<MemoryHubSettingsUpdateResult>((resolve) => {
        release = resolve;
      }),
  );
  const flow = memoryDeviceFlow(options(update));
  const pending = flow.run();
  flow.dispose();
  release(result);
  await expect(pending).rejects.toThrow("Device disconnected");
  expect(update).toHaveBeenCalledTimes(1);
  await expect(flow.run()).rejects.toThrow("Device disconnected");
});
it("uses rotation for recovery and stops if permission is lost after installing", async () => {
  let active = true;
  const update = vi.fn(async (_id: EnvironmentId, input: MemoryHubSettingsUpdateInput) => {
    if (input.action === "installCredential") active = false;
    return result;
  });
  const flow = memoryDeviceFlow({
    ...options(update),
    action: "rotateMemberCredential",
    isActive: () => active,
  });
  await expect(flow.run()).rejects.toThrow("Device disconnected");
  expect(update.mock.calls.map((c) => c[1].action)).toEqual([
    "rotateMemberCredential",
    "installCredential",
  ]);
});
