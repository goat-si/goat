import type { RouterHistory } from "@tanstack/react-router";

/** Where GOAT opens: every launch, restart, and update lands on Fleet. */
export const LAUNCH_PATH = "/fleet";

/**
 * Runs once, before the router reads the address. A document that starts at "/" opens Fleet,
 * replacing the entry so Back does not return to "/". Later visits to "/" (the logo, Go home)
 * still open the global agent, and any other starting address, such as a thread, a draft, or a
 * prompt link, opens as asked. The hosted app keeps "/", which owns its empty state and sign-in.
 * Nothing at "/" reads a query, and Electron's hash history reports the outer query as the
 * route's, so carrying it would copy it into the hash and double it on every reload.
 */
export function openLaunchRoute(
  history: RouterHistory,
  options: { readonly hostedStatic: boolean },
): void {
  if (options.hostedStatic || history.location.pathname !== "/") return;
  history.replace(LAUNCH_PATH);
}

/**
 * Where a launch lands when nothing more specific was asked for: Fleet, or "/" on the hosted
 * app. First-run setup may take over only here; a page opened by a direct link stays put.
 */
export function isLaunchLanding(pathname: string): boolean {
  return pathname === LAUNCH_PATH || pathname === "/";
}
