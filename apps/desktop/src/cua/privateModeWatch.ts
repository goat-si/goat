import type { DesktopCuaPrivateModeReport } from "@goat/contracts";

import type { HelperEvent, HelperSession } from "./ComputerUseHelper.ts";

type Watchable = Pick<HelperSession, "watch" | "unwatch" | "onEvent">;
type Target = DesktopCuaPrivateModeReport["target"];

/**
 * Keeps the helper's private-mode watch in step with whether agents control this host (the
 * server's cuaWatch), and passes what it sees on as cuaPrivateMode (#1235). The watch runs only
 * while an agent does (D7). A helper that goes away while a secret field had focus is reported
 * cleared, as the protocol has a helper's exit clear everything it reported.
 */
export function makePrivateModeFollower(deps: {
  readonly publish: (report: DesktopCuaPrivateModeReport) => void;
  readonly newWatchId: () => string;
}) {
  let watching = false;
  let session: Watchable | undefined;
  let watchedBy: Watchable | undefined;
  let unsubscribe: (() => void) | undefined;
  let active: Target | undefined;
  let chain = Promise.resolve();

  const report = (isActive: boolean, target: Target) =>
    deps.publish({ version: 1, type: "cuaPrivateMode", active: isActive, target });
  const onEvent = (event: HelperEvent["event"]) => {
    if (event.type !== "privateMode") return;
    // An inactive first state names no window; there is nothing to clear.
    if (!event.active && active === undefined) return;
    active = event.active ? event.target : undefined;
    report(event.active, event.target);
  };
  const reconcile = async () => {
    const current = session;
    if (current === undefined) return;
    if (watching && watchedBy !== current) {
      await current.watch(deps.newWatchId());
      watchedBy = current;
    } else if (!watching && watchedBy === current) {
      await current.unwatch();
      watchedBy = undefined;
    }
  };
  // One change at a time, in order; a helper that cannot watch leaves the signal unraised.
  const settle = () => {
    chain = chain.then(reconcile).catch(() => undefined);
    return chain;
  };

  return {
    setWatching: (next: boolean) => {
      watching = next;
      return settle();
    },
    /** The helper session of a generation that just started. */
    attach: (next: Watchable) => {
      if (session === next) return chain;
      session = next;
      unsubscribe?.();
      unsubscribe = next.onEvent(onEvent);
      return settle();
    },
    /** The generation ended; whatever it reported active is over. */
    detach: () => {
      unsubscribe?.();
      unsubscribe = undefined;
      session = undefined;
      watchedBy = undefined;
      if (active !== undefined) report(false, active);
      active = undefined;
    },
  };
}
