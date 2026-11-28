// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

export const makeDebuggee = (
  options: {
    readonly deferFocus?: boolean;
    readonly refuse?: (method: string, sessionId: string | undefined) => boolean;
  } = {},
) => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const focusChanges: Array<() => void> = [];
  const sent: Array<unknown> = [];
  /** Commands the host sends on its own (no relay id), such as ending an input hold. */
  const own: Array<{ method: string; params: unknown }> = [];
  const sendWaiters: Array<() => void> = [];
  const ownWaiters = new Map<string, () => void>();
  const focusEmulation: Array<boolean> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (
      method: string,
      params?: { id?: number; enabled?: boolean },
      sessionId?: string,
    ) =>
      new Promise((resolve, reject) => {
        if (options.refuse?.(method, sessionId)) {
          reject(new Error("Refused"));
          return;
        }
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        const expression = (params as { expression?: string } | undefined)?.expression;
        if (
          method === "Input.setIgnoreInputEvents" ||
          method === "Page.stopScreencast" ||
          (method === "Runtime.evaluate" && expression?.includes("__goatAgentInputHeld"))
        ) {
          own.push({ method, params });
          resolve({});
          ownWaiters.get(method)?.();
          return;
        }
        if (method === "Emulation.setFocusEmulationEnabled") {
          focusEmulation.push(params?.enabled === true);
          if (options.deferFocus) focusChanges.push(() => resolve({}));
          else resolve({});
          return;
        }
        sent.push(params?.id);
        pending.push(() => resolve({ method }));
        sendWaiters.shift()?.();
      }),
  });
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    capturePage: () => Promise.resolve({}),
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
  });
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    webContents,
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    navigate: () => webContents.emit("did-navigate"),
    /** Ids of the commands the debugger received, in order. */
    sent,
    own,
    focusEmulation,
    nextSend: () => new Promise<void>((resolve) => sendWaiters.push(resolve)),
    /** Resolves when the host itself sends `method`. */
    sentOwn: (method: string) => new Promise<void>((resolve) => ownWaiters.set(method, resolve)),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
    releaseFirst: () => pending.shift()?.(),
    settleFocus: () => focusChanges.splice(0).forEach((resolve) => resolve()),
  };
};
