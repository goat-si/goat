import { useAtomValue } from "@effect/atom-react";
import type { DesktopEnvironmentBootstrap } from "@goat/contracts";
import { Atom } from "effect/reactivity";

import {
  DESKTOP_LOCAL_BOOTSTRAPS_CACHE_TTL_MS,
  readDesktopSecondaryBootstraps,
} from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = DESKTOP_LOCAL_BOOTSTRAPS_CACHE_TTL_MS;

/**
 * The bridge exposes no change event, so this re-reads on a low-frequency visible
 * interval while anything reads it; failed reads retain the latest successful snapshot,
 * while a successful empty read clears it. The reader returns the same array while
 * nothing changed, so an unchanged poll notifies no one.
 */
const desktopLocalBootstrapsAtom = Atom.make((get) => {
  if (typeof window !== "undefined" && window.desktopBridge !== undefined) {
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      get.setSelf(readDesktopSecondaryBootstraps());
    }, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
    get.addFinalizer(() => clearInterval(interval));
  }
  return readDesktopSecondaryBootstraps();
}).pipe(Atom.withLabel("desktop-local-bootstraps"));

export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useAtomValue(desktopLocalBootstrapsAtom);
}
