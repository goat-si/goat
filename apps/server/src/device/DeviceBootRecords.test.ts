import { describe, expect, it } from "vite-plus/test";
import { DeviceId, ThreadId, type DeviceServiceState, type DeviceSummary } from "@goat/contracts";

import { withBootRecords } from "./DeviceBootRecords.ts";

const lane = ThreadId.make("lane");
const device = (id: string, name: string, booted: boolean, hostId = "local"): DeviceSummary => ({
  hostId,
  id: DeviceId.make(id),
  name,
  platform: "android",
  version: "15",
  physical: false,
  booted,
});
const state = (patch: Partial<DeviceServiceState>): DeviceServiceState => ({
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This Mac",
      platforms: [{ platform: "android", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/hub",
  revision: 0,
  ...patch,
});

describe("withBootRecords", () => {
  const stopped = device("Pixel_API_35", "Pixel", false);
  const booting = state({
    devices: [stopped],
    bootingDevices: [{ ...stopped, threadId: lane }],
  });

  it("remembers which thread started a device, through the id change Android makes on boot", () => {
    const started = withBootRecords(state({ devices: [stopped] }), booting);
    const running = withBootRecords(
      started,
      state({ devices: [device("emulator-5554", "Pixel", true)] }),
    );
    expect(running.bootedBy).toEqual([
      { hostId: "local", deviceId: "Pixel_API_35", deviceName: "Pixel", threadId: lane },
    ]);
  });

  it("forgets a device once it is listed as stopped, or its host is gone", () => {
    const started = withBootRecords(state({ devices: [stopped] }), booting);
    expect(withBootRecords(started, state({ devices: [stopped] })).bootedBy).toEqual([]);
    expect(withBootRecords(started, state({ hosts: [], devices: [] })).bootedBy).toEqual([]);
  });

  it("keeps a record while the device is still starting", () => {
    const started = withBootRecords(state({ devices: [stopped] }), booting);
    expect(withBootRecords(started, booting).bootedBy).toHaveLength(1);
    // Boot finishes before the next listing arrives; the stale listing still says stopped.
    const bootEnded = withBootRecords(started, { ...started, bootingDevices: [] });
    expect(bootEnded.bootedBy).toHaveLength(1);
  });
});
