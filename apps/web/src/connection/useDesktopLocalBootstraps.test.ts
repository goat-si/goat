import { type DesktopEnvironmentBootstrap, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  invalidateDesktopLocalBootstrapsCache,
  readDesktopSecondaryBootstrapsResult,
} from "./desktopLocal";
import { createDesktopLocalBootstrapsAtom } from "./useDesktopLocalBootstraps";

describe("createDesktopLocalBootstrapsAtom", () => {
  afterEach(() => {
    invalidateDesktopLocalBootstrapsCache();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("skips hidden polls and forces a fresh topology read when returning to visible", () => {
    vi.useFakeTimers();
    const docTarget = new EventTarget();
    let visibilityState: DocumentVisibilityState = "hidden";
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: docTarget.addEventListener.bind(docTarget),
      removeEventListener: docTarget.removeEventListener.bind(docTarget),
    });

    const primary: DesktopEnvironmentBootstrap = {
      id: PRIMARY_LOCAL_ENVIRONMENT_ID,
      label: "Windows",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bootstrapToken: "bootstrap-1",
    };
    const wsl: DesktopEnvironmentBootstrap = {
      id: "wsl:Ubuntu",
      label: "WSL: Ubuntu",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:4000",
      wsBaseUrl: "ws://127.0.0.1:4000",
      bootstrapToken: "bootstrap-1",
    };
    let entries: readonly DesktopEnvironmentBootstrap[] = [primary];
    const getLocalEnvironmentBootstraps = vi.fn(() => entries);
    vi.stubGlobal("window", {
      desktopBridge: { getLocalEnvironmentBootstraps },
    });

    const atom = createDesktopLocalBootstrapsAtom();
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);
    try {
      expect(registry.get(atom)).toEqual([]);
      expect(getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(1);

      // While hidden, interval ticks do not poll IPC.
      vi.advanceTimersByTime(30_000);
      expect(getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(1);

      // Platform read repopulates the shared 15s cache right before WSL starts and user returns.
      expect(readDesktopSecondaryBootstrapsResult()._tag).toBe("Success");
      expect(getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(2);

      entries = [primary, wsl];
      visibilityState = "visible";
      docTarget.dispatchEvent(new Event("visibilitychange"));

      // Returning to foreground bypasses the shared cache and surfaces the updated WSL topology immediately.
      expect(registry.get(atom)).toEqual([wsl]);
      expect(getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(3);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});
