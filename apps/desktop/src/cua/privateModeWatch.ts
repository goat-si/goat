import type { DesktopCuaPrivateModeReport } from "@goat/contracts";

import type { HelperEvent, HelperSession } from "./ComputerUseHelper.ts";

type Watchable = Pick<HelperSession, "watch" | "unwatch" | "onEvent" | "canWatch">;
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
  /** Runs a retry later, after a watch or unwatch failed while it still matters. */
  readonly retryLater: (retry: () => void) => void;
}) {
  let watching = false;
  let session: Watchable | undefined;
  let watchedBy: Watchable | undefined;
  let unsubscribe: (() => void) | undefined;
  let active: Target | undefined;
  // A watch or unwatch failed, so the helper may be watching whatever this follower believes.
  let unsure = false;
  let retryPending = false;
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
    if (current === undefined || !current.canWatch) return;
    try {
      if (watching && (watchedBy !== current || unsure)) {
        await current.watch(deps.newWatchId());
        watchedBy = current;
        unsure = false;
      } else if (!watching && (watchedBy === current || unsure)) {
        await current.unwatch();
        watchedBy = undefined;
        unsure = false;
      }
    } catch {
      unsure = true;
      // One retry at a time: it reads the state current when it runs.
      if (!retryPending) {
        retryPending = true;
        deps.retryLater(() => {
          retryPending = false;
          void settle();
        });
      }
    }
  };
  // One change at a time, in order.
  const settle = () => {
    chain = chain.then(reconcile);
    return chain;
  };

  return {
    setWatching: (next: boolean) => {
      watching = next;
      // A stopped watch never reports the field losing focus, so what it reported ends here;
      // otherwise the server would keep the host paused with no one left to clear it.
      if (!next && active !== undefined) {
        report(false, active);
        active = undefined;
      }
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
      unsure = false;
      if (active !== undefined) report(false, active);
      active = undefined;
    },
  };
}
