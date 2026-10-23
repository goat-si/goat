import { entry } from "../entry.ts";

export const deviceEntries = {
  "device.screenshot": entry({
    resource: "device",
    verb: "screenshot",
    name: "device_screenshot",
    toolkit: "device",
    summary: "Screenshot device",
    description:
      "Capture the current screen of an open device as a PNG image. Use it to see what the user sees; for taps and text use the agent-device CLI.",
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
      "List iOS Simulators and Android Emulators on this environment's device hosts, which platforms each host can run, and which devices are already open in this thread's Device panel. Call this before goat_device_open when you do not know a device id.",
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
      "Open a simulator or emulator for this thread: boots it if needed, starts its live stream, and shows it in the user's Device panel so they can watch. Returns the agent-device CLI invocation pinned to the device; drive the device with that CLI afterwards.",
    effect: "write",
    capability: "none",
    capabilityReason: "Opens a simulator for the calling thread only.",
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
      "Remove a device from this thread's Device panel. Pass shutdown=true to also power the simulator or emulator off.",
    effect: "destructive",
    capability: "none",
    capabilityReason: "Closes the calling thread's own simulator.",
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
