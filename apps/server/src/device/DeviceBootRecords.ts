import type { DeviceServiceState } from "@goat/contracts";

type BootRecord = NonNullable<DeviceServiceState["bootedBy"]>[number];

const sameDevice = (record: BootRecord, device: DeviceServiceState["devices"][number]) =>
  device.hostId === record.hostId &&
  // Android swaps the AVD name for an emulator serial once it boots.
  (device.id === record.deviceId || device.name === record.deviceName);

/**
 * Remembers which thread started each running device, so a device left running by a finished
 * thread can be attributed. Display only: nothing stops a device because of a record.
 */
export function withBootRecords(
  previous: DeviceServiceState,
  next: DeviceServiceState,
): DeviceServiceState {
  const starting: ReadonlyArray<BootRecord> = (next.bootingDevices ?? []).map((device) => ({
    hostId: device.hostId,
    deviceId: device.id,
    deviceName: device.name,
    threadId: device.threadId,
  }));
  const hosts = new Set(next.hosts.map((host) => host.id));
  // Only a new listing says a device stopped; other updates carry the previous listing along.
  const listed = next.devices === previous.devices ? [] : next.devices;
  const kept = (previous.bootedBy ?? []).filter(
    (record) =>
      hosts.has(record.hostId) &&
      !starting.some(
        (entry) => entry.hostId === record.hostId && entry.deviceId === record.deviceId,
      ) &&
      !listed.some((device) => sameDevice(record, device) && !device.booted),
  );
  return { ...next, bootedBy: [...kept, ...starting] };
}
