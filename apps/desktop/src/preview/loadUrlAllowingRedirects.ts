import * as Predicate from "effect/Predicate";

interface NavigationDetails {
  readonly isMainFrame: boolean;
  readonly isSameDocument: boolean;
}

const ERR_ABORTED = -3;
const loads = new WeakMap<Electron.WebContents, number>();

/**
 * Loads a URL, settling as success when the page itself redirected the main frame away.
 * ERR_ABORTED also means a blocked unload or a newer navigate() replaced this load; both stay failures.
 */
export function loadUrlAllowingRedirects(wc: Electron.WebContents, url: string): Promise<void> {
  const load = (loads.get(wc) ?? 0) + 1;
  loads.set(wc, load);
  let redirected = false;
  let unloadPrevented = false;
  const onRedirect = (details: NavigationDetails) => {
    if (details.isMainFrame && !details.isSameDocument) redirected = true;
  };
  const onPreventUnload = () => {
    unloadPrevented = true;
  };
  wc.on("will-navigate", onRedirect);
  wc.on("did-redirect-navigation", onRedirect);
  wc.on("will-prevent-unload", onPreventUnload);
  const detach = () => {
    wc.off("will-navigate", onRedirect);
    wc.off("did-redirect-navigation", onRedirect);
    wc.off("will-prevent-unload", onPreventUnload);
  };
  return wc.loadURL(url).then(detach, (error: unknown) => {
    detach();
    const aborted = Predicate.hasProperty(error, "errno") && error.errno === ERR_ABORTED;
    if (aborted && redirected && !unloadPrevented && loads.get(wc) === load) return;
    throw error;
  });
}
