import type { DesktopBridge } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "./ipc/channels.ts";

const ipc = vi.hoisted(() => ({
  bridge: undefined as DesktopBridge | undefined,
  invoke: vi.fn<(channel: string, input: unknown) => Promise<unknown>>(),
  listeners: new Map<string, Set<(event: unknown, id: unknown) => void>>(),
}));

vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: () => {} }));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, bridge: DesktopBridge) => {
      if (name === "desktopBridge") ipc.bridge = bridge;
    },
  },
  ipcRenderer: {
    sendSync: () => null,
    invoke: ipc.invoke,
    on: (channel: string, listener: (event: unknown, id: unknown) => void) => {
      const listeners = ipc.listeners.get(channel) ?? new Set();
      listeners.add(listener);
      ipc.listeners.set(channel, listeners);
    },
    removeListener: (channel: string, listener: (event: unknown, id: unknown) => void) => {
      const listeners = ipc.listeners.get(channel);
      listeners?.delete(listener);
      if (listeners?.size === 0) ipc.listeners.delete(channel);
    },
  },
  webFrame: {},
  webUtils: {},
}));

// Loaded while the file is collected: in a hook, the preload's transform counts against the hook
// timeout, which a loaded CI runner exceeds.
vi.stubGlobal("window", { addEventListener: () => {} });
try {
  await import("./preload.ts");
} finally {
  vi.unstubAllGlobals();
}

const emit = (action: unknown) => {
  for (const listener of ipc.listeners.get(IpcChannels.TRAY_ACTION_CHANNEL) ?? []) {
    listener({}, action);
  }
};

describe("tray actions in preload", () => {
  it("delivers stop actions and drops an unknown kind", () => {
    const received: unknown[] = [];
    const unsubscribe = ipc.bridge!.onTrayAction!((action) => {
      received.push(action);
    });
    emit({ kind: "stop-computer-use", appId: "com.apple.calculator" });
    emit({ kind: "stop-all-computer-use" });
    emit({ kind: "bogus" });
    unsubscribe();
    expect(received).toEqual([
      { kind: "stop-computer-use", appId: "com.apple.calculator" },
      { kind: "stop-all-computer-use" },
    ]);
  });
});
