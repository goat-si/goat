import type { RouterHistory } from "@tanstack/react-router";

/** Where GOAT opens: every launch, restart, and update lands on Fleet. */
export const LAUNCH_PATH = "/fleet";

/**
 * Runs once, before the router reads the address. A document that starts at "/" opens Fleet,
 * replacing the entry so Back does not return to "/". Later visits to "/" (the logo, Go home)
 * still open the global agent, and any other starting address, such as a thread, a draft, or a
 * prompt link, opens as asked. The hosted app keeps "/", which owns its empty state and sign-in.
 */
export function openLaunchRoute(
  history: RouterHistory,
  options: { readonly hostedStatic: boolean },
): void {
  const { pathname, search, hash } = history.location;
  if (options.hostedStatic || pathname !== "/") return;
  history.replace(`${LAUNCH_PATH}${search}${hash}`);
}

/**
 * Where a launch lands when nothing more specific was asked for: Fleet, or "/" on the hosted
 * app. Only here may startup move on by itself, to first-run setup or to the thread `goat` opened
 * for its directory; a page opened by a direct link stays put.
 */
export function isLaunchLanding(pathname: string): boolean {
  return pathname === LAUNCH_PATH || pathname === "/";
}
