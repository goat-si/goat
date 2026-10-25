/**
 * Which thread uses an app now (ADR-0023 D17, #1671). A thread's admitted mutating call on an
 * app's window leases that app to the thread's control. Another thread's mutating call on the
 * app, or a desktop call that could reach it, is refused `app_busy` while the lease lasts;
 * reads need no lease.
 *
 * A lease names the app by the id the proxy judged the call by when it knows one (a bundle id on
 * macOS, otherwise the id list_apps reports; never a display name, #1484) and always by the pid
 * the call acted on. Two calls meet on either, so a full access thread whose proxy never needed
 * the app's id still meets a granted thread's lease on the same process.
 *
 * Nothing here runs on a timer. A lease is judged at each check against its holder's current
 * control, so Stop, Stop all, expiry, replacement, an idle turn, leaving full access, deleting
 * the thread and a narrowed grant that drops the app all end it, and so does APP_LEASE_IDLE_MS
 * without a mutating call on it. An ended lease is dropped when a check meets it; the proxy
 * closing its driver releases the control's leases at once.
 *
 * @module ComputerUseAppLeases
 */
import type { ComputerUseCallReservation, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { callResource } from "./ComputerUseCallReservations.ts";

/** How long an app stays leased after its holder's last mutating call on it. */
export const APP_LEASE_IDLE_MS = 60_000;

type Call = Extract<ComputerUseCallReservation, { action: "reserve" }>;

/** What a call needs free: nothing, one app (its process, and its id when known), or every app. */
export type AppNeed =
  | { readonly _tag: "none" }
  | { readonly _tag: "app"; readonly pid: number; readonly app: string | undefined }
  | { readonly _tag: "every" };

/** A desktop call may reach any app; a window call acts on its window's app. */
export const appNeed = (call: Call): AppNeed => {
  const resource = callResource(call);
  if (resource === "read" || resource === "invalid") return { _tag: "none" };
  if (resource === "desktop") return { _tag: "every" };
  return { _tag: "app", pid: resource.pid, app: call.app };
};

/** Another thread's lease in a call's way. */
export interface AppBusy {
  readonly holderThreadId: ThreadId;
  readonly app: string;
}

interface Lease {
  /** Every process the app was used in under this lease. */
  readonly pids: ReadonlyArray<number>;
  readonly app: string | undefined;
  readonly threadId: ThreadId;
  readonly controlId: string;
  readonly usedAt: number;
}

// Grants and the proxy compare app ids without case (ComputerUseScope.approvedApps).
const sameApp = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
const meets = (lease: Lease, need: Extract<AppNeed, { _tag: "app" }>) =>
  lease.pids.includes(need.pid) || sameApp(lease.app, need.app);

/** Owned by the lease service; every operation runs inside its admission permit. */
export const makeAppLeases = <E>(options: {
  /** Whether this control of the thread still holds the app: live, not idle, still allowed it. */
  readonly holds: (
    threadId: ThreadId,
    controlId: string,
    app: string | undefined,
  ) => Effect.Effect<boolean, E>;
}) => {
  let leases: ReadonlyArray<Lease> = [];
  const drop = (lease: Lease) => {
    leases = leases.filter((other) => other !== lease);
  };
  /** Another thread's live lease in the way of `need`, dropping the ones that ended. */
  const busy = Effect.fn("ComputerUseAppLeases.busy")(function* (
    threadId: ThreadId,
    need: AppNeed,
    now: number,
  ) {
    if (need._tag === "none") return undefined;
    for (const lease of leases) {
      if (lease.threadId === threadId || (need._tag === "app" && !meets(lease, need))) continue;
      if (
        lease.usedAt + APP_LEASE_IDLE_MS > now &&
        (yield* options.holds(lease.threadId, lease.controlId, lease.app))
      )
        return {
          holderThreadId: lease.threadId,
          app:
            lease.app ??
            (need._tag === "app" ? need.app : undefined) ??
            `the app with pid ${lease.pids.join(", ")}`,
        } satisfies AppBusy;
      drop(lease);
    }
    return undefined;
  });
  /** An admitted mutating call on one app leases it, or renews its lease, for its control. */
  const hold = (threadId: ThreadId, controlId: string, need: AppNeed, now: number) => {
    if (need._tag !== "app") return;
    const own = leases.filter((lease) => lease.threadId === threadId && meets(lease, need));
    const app = need.app ?? own.find((lease) => lease.app !== undefined)?.app;
    const pids = [...new Set([...own.flatMap((lease) => lease.pids), need.pid])];
    leases = [
      ...leases.filter((lease) => !own.includes(lease)),
      { pids, app, threadId, controlId, usedAt: now },
    ];
  };
  /** The control's proxy closed its driver (it exited, crashed or lost its connection). */
  const release = (threadId: ThreadId, controlId: string) => {
    leases = leases.filter((lease) => lease.threadId !== threadId || lease.controlId !== controlId);
  };
  return { busy, hold, release, held: () => leases.length };
};
