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
 * Nothing here runs on a timer. A lease (H1) is judged at each check against its holder's
 * current control, so Stop, Stop all, expiry, replacement, an idle turn, leaving full access,
 * deleting the thread and a narrowed grant that drops the app all end it, and so does
 * APP_LEASE_IDLE_MS without a mutating call on it; the proxy closing its driver or losing its lease
 * stream releases it at once, and a call refused before anything reached the app gives back what
 * its own hold took. A call of another control still out in the app holds it too (H2, H3
 * in ComputerUseCallReservations.appTicket). The PR that added D17 (#1679) states the invariants
 * and their bounds.
 *
 * @module ComputerUseAppLeases
 */
import type { ComputerUseCallReservation, ThreadId } from "@goat/contracts";
import { cuaAppKey } from "@goat/shared/cuaDriverManifest";
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

/** One admitted call's use of the app: its process, its app id when known, and when. */
interface Use {
  readonly pid: number;
  readonly app: string | undefined;
  readonly usedAt: number;
}

/** An admitted call not yet answered, with the driver connection that alone may settle it. */
interface Pending extends Use {
  readonly controlId: string;
  readonly connectionId: string;
}

interface Lease {
  /** Every process the app was used in under this lease. */
  readonly pids: ReadonlyArray<number>;
  readonly app: string | undefined;
  readonly threadId: ThreadId;
  readonly controlId: string;
  readonly usedAt: number;
  /** The calls that ran, or whose outcome GOAT never learned, as one use per process. */
  readonly settled: ReadonlyArray<Use>;
  /** Admitted calls whose ticket is still out, by reservation; a call never sent leaves no trace. */
  readonly pending: ReadonlyMap<string, Pending>;
}

const makeLease = (
  threadId: ThreadId,
  controlId: string,
  settled: ReadonlyArray<Use>,
  pending: ReadonlyMap<string, Pending>,
): Lease => {
  const uses = [...settled, ...pending.values()];
  return {
    pids: [...new Set(uses.map((use) => use.pid))],
    app: uses.find((use) => use.app !== undefined)?.app,
    threadId,
    controlId,
    usedAt: Math.max(...uses.map((use) => use.usedAt)),
    settled,
    pending,
  };
};
/** Settled uses of one process collapse into its latest, so a long-held lease does not grow. */
const addSettled = (uses: ReadonlyArray<Use>, use: Use): ReadonlyArray<Use> => [
  ...uses.filter((other) => other.pid !== use.pid),
  {
    pid: use.pid,
    app: use.app ?? uses.find((other) => other.pid === use.pid)?.app,
    usedAt: Math.max(use.usedAt, ...uses.filter((o) => o.pid === use.pid).map((o) => o.usedAt)),
  },
];

// Grants and the proxy compare app ids without case (ComputerUseScope.approvedApps).
const sameApp = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && cuaAppKey(a) === cuaAppKey(b);
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
  /**
   * An admitted mutating call on one app leases it, or renews its lease, for its control. A
   * confirmation under the same reservation renews that call's own use.
   */
  const hold = (
    threadId: ThreadId,
    controlId: string,
    need: AppNeed,
    now: number,
    ticket?: { readonly reservationId: string; readonly connectionId: string },
  ) => {
    if (need._tag !== "app") return;
    const own = leases.filter((other) => other.threadId === threadId && meets(other, need));
    const use: Use = { pid: need.pid, app: need.app, usedAt: now };
    let settled = own
      .flatMap((other) => other.settled)
      .reduce(addSettled, [] as ReadonlyArray<Use>);
    const pending = new Map(own.flatMap((other) => [...other.pending]));
    if (ticket === undefined) settled = addSettled(settled, use);
    else
      pending.set(ticket.reservationId, { ...use, controlId, connectionId: ticket.connectionId });
    leases = [
      ...leases.filter((other) => !own.includes(other)),
      makeLease(threadId, controlId, settled, pending),
    ];
  };
  /**
   * The thread's ticket for this call was released. A call that ran keeps its use; one nothing of
   * which was sent takes its use back, and the lease ends when no other use is left.
   */
  const settle = (
    threadId: ThreadId,
    call: { readonly controlId: string; readonly connectionId: string },
    reservationId: string,
    notSent: boolean,
  ) => {
    const held = leases.find(
      (other) => other.threadId === threadId && other.pending.has(reservationId),
    );
    const use = held?.pending.get(reservationId);
    // Only the driver connection that holds the call may settle what it took.
    if (
      held === undefined ||
      use === undefined ||
      use.controlId !== call.controlId ||
      use.connectionId !== call.connectionId
    )
      return;
    const pending = new Map(held.pending);
    pending.delete(reservationId);
    const settled = notSent
      ? held.settled
      : addSettled(held.settled, { pid: use.pid, app: use.app, usedAt: use.usedAt });
    const rest = leases.filter((other) => other !== held);
    leases =
      settled.length === 0 && pending.size === 0
        ? rest
        : [...rest, makeLease(held.threadId, held.controlId, settled, pending)];
  };
  /** The control's proxy closed its driver (it exited, crashed or lost its connection). */
  const release = (threadId: ThreadId, controlId: string) => {
    leases = leases.filter((other) => other.threadId !== threadId || other.controlId !== controlId);
  };
  return { busy, hold, settle, release, held: () => leases.length };
};
