import { useAtomValue } from "@effect/atom-react";
import type { DesktopEnvironmentBootstrap } from "@goat/contracts";
import { Atom } from "effect/reactivity";

import {
  DESKTOP_LOCAL_BOOTSTRAPS_CACHE_TTL_MS,
  readDesktopSecondaryBootstraps,
} from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = DESKTOP_LOCAL_BOOTSTRAPS_CACHE_TTL_MS;

/**
 * Re-reads secondary bootstraps on a low-frequency visible interval and forces a fresh read
 * when returning to the foreground; failed reads retain the latest successful snapshot.
 */
export function createDesktopLocalBootstrapsAtom() {
  return Atom.make((get) => {
    if (typeof window !== "undefined" && window.desktopBridge !== undefined) {
      const interval = setInterval(() => {
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        get.setSelf(readDesktopSecondaryBootstraps());
      }, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          get.setSelf(readDesktopSecondaryBootstraps({ force: true }));
        }
      };
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibilityChange);
      }
      get.addFinalizer(() => {
        clearInterval(interval);
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", onVisibilityChange);
        }
      });
    }
    return readDesktopSecondaryBootstraps();
  }).pipe(Atom.withLabel("desktop-local-bootstraps"));
}

const desktopLocalBootstrapsAtom = createDesktopLocalBootstrapsAtom();

export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useAtomValue(desktopLocalBootstrapsAtom);
}
