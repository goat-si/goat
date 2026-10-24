import type { DesktopBridge, DesktopWindowMaterialState } from "@goat/contracts";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import * as Channels from "./ipc/channels.ts";

const ipc = vi.hoisted(() => ({
  bridge: undefined as DesktopBridge | undefined,
  invoke: vi.fn<() => Promise<unknown>>(),
  listeners: new Map<string, (event: unknown, value: unknown) => void>(),
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
    on: (channel: string, listener: (event: unknown, value: unknown) => void) =>
      ipc.listeners.set(channel, listener),
    removeListener: (channel: string) => ipc.listeners.delete(channel),
  },
  webFrame: {},
  webUtils: {},
}));
beforeAll(async () => {
  vi.stubGlobal("window", { addEventListener: () => {} });
  try {
    await import("./preload.ts");
  } finally {
    vi.unstubAllGlobals();
  }
});

const state: DesktopWindowMaterialState = {
  revision: 1,
  capability: { supported: false, reason: "api-unavailable" },
  enabled: false,
  applied: "none",
  reason: "unsupported",
  reducedTransparency: false,
  highContrast: false,
};

describe("window material preload bridge", () => {
  it("decodes invoke results and rejects malformed material state", async () => {
    const get = ipc.bridge?.getWindowMaterialState;
    expect(get).toBeTypeOf("function");
    if (!get) throw new Error("material bridge is absent");
    ipc.invoke.mockResolvedValueOnce(state);
    expect(await get()).toEqual(state);
    expect(ipc.invoke).toHaveBeenLastCalledWith(Channels.GET_WINDOW_MATERIAL_STATE_CHANNEL);
    ipc.invoke.mockResolvedValueOnce({ ...state, revision: "old" });
    await expect(get()).rejects.toThrow("Invalid desktop window material state.");
  });

  it("filters malformed pushed states and unregisters the observer", () => {
    const subscribe = ipc.bridge?.onWindowMaterialStateChanged;
    if (!subscribe) throw new Error("material subscription is absent");
    const received: DesktopWindowMaterialState[] = [];
    const unsubscribe = subscribe((value) => received.push(value));
    const send = ipc.listeners.get(Channels.WINDOW_MATERIAL_STATE_CHANNEL);
    if (!send) throw new Error("material listener is absent");
    for (const value of [
      null,
      {},
      { ...state, applied: "vibrancy" },
      { ...state, capability: { supported: true, material: "none" } },
    ])
      send({}, value);
    expect(received).toEqual([]);
    send({}, state);
    expect(received).toEqual([state]);
    unsubscribe();
    expect(ipc.listeners.has(Channels.WINDOW_MATERIAL_STATE_CHANNEL)).toBe(false);
  });
});
