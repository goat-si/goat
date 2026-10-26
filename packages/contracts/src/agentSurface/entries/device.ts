import { entry } from "../entry.ts";

export const deviceEntries = {
  "device.screenshot": entry({
    resource: "device",
    verb: "screenshot",
    name: "device_screenshot",
    toolkit: "device",
    summary: "Screenshot device",
    description:
      "Capture the screen of a device open in this thread as a PNG. Drive taps and text with the agent-device CLI returned by goat_device_open.",
    guide:
      "With no target, captures the most recently opened matching device. Needs agent device access for this thread's project, and device support turned on.",
    effect: "read",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Screenshot device",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "device.list": entry({
    resource: "device",
    verb: "list",
    name: "device_list",
    toolkit: "device",
    summary: "List devices",
    description:
      "List simulators and emulators on this environment’s device hosts, host platform support, and devices open in this thread.",
    guide:
      "Call goat_device_list before goat_device_open when the target device is unknown. Needs agent device access for this thread's project, and device support turned on.",
    effect: "read",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "List devices",
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
  "device.open": entry({
    resource: "device",
    verb: "open",
    name: "device_open",
    toolkit: "device",
    summary: "Open device",
    description:
      "Boot or attach a simulator or emulator in this thread’s Device panel. Use the returned agent-device command and target flags on every call. Retry with the same clientRequestId to avoid booting or billing another device.",
    guide:
      "Needs agent device access for this thread's project, and device support turned on. Keep the exact returned executable path: login shells can reset PATH. Retain all --config and --session flags so concurrent hosts do not change the target. Remote app installation, builds, and Metro forwarding are separate work. For a cloud EAS session, close with shutdown enabled when finished to stop per-minute billing.",
    effect: "write",
    capability: "none",
    capabilityReason: "Opens a simulator for the calling thread only.",
    idempotency: "key",
    reconcile: "device.list",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Open device",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "device.close": entry({
    resource: "device",
    verb: "close",
    name: "device_close",
    toolkit: "device",
    summary: "Close device",
    description:
      "Remove matching devices from this thread’s Device panel; optionally shut them down too. Closing without shutdown leaves the simulator or emulator running.",
    guide:
      "An omitted target closes all matching sessions in the thread. Shutdown also removes sessions for that device in other threads.",
    effect: "destructive",
    capability: "none",
    capabilityReason: "Closes the calling thread's own simulator.",
    idempotencyReason:
      "Removes matching sessions from the calling thread before optional shutdown; repeating after removal finds no sessions and performs no further shutdown, including when that shutdown failed.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Close device",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
} as const;
