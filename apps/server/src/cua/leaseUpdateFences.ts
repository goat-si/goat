/**
 * What the lease updates a proxy has taken but not applied yet hold back (#1416). The proxy takes
 * each update as soon as it arrives, even while an earlier one waits for the lifecycle lock, and
 * no call passes a pause, end, idle turn or narrowed approval that is already known.
 *
 * @module leaseUpdateFences
 */
import type { ComputerUseLeaseUpdate, ComputerUsePauseReason } from "@goat/contracts";

import type { LeaseEnd } from "./ComputerUseLeaseMessages.ts";
import { approvedApps } from "./ComputerUseScope.ts";

export type Stopping =
  | { readonly pause: ComputerUsePauseReason }
  | { readonly end: LeaseEnd }
  | { readonly idle: true }
  /** An approval that drops apps the control allows: nothing passes until it applies. */
  | { readonly narrowed: true };

export function makeLeaseFences(controlId: string) {
  const fences: Array<Stopping> = [];
  /** The apps of the latest active update taken, applied or not; undefined allows every app. */
  let takenApps: ReadonlySet<string> | undefined;
  let takenActive = false;
  const raise = (fence: Stopping) => {
    fences.push(fence);
    return fence;
  };
  return {
    /**
     * Records an update as taken and returns the fence it raised, if any. `applied` is the
     * approval in force now; an update that drops an app it allows, or that the latest update
     * taken allows, holds every call until it applies.
     */
    take: (
      update: ComputerUseLeaseUpdate,
      applied: ReadonlySet<string> | undefined,
    ): Stopping | undefined => {
      if (update.state !== "ended" && update.controlId !== controlId) return raise({ end: "lost" });
      if (update.state === "paused") return raise({ pause: update.reason });
      if (update.state === "ended")
        return raise({ end: update.reason === "unauthorized" ? "lost" : update.reason });
      if (update.state === "idle") return raise({ idle: true });
      const next = approvedApps(update.apps);
      const drops = (from: ReadonlySet<string> | undefined) =>
        next !== undefined && (from === undefined || [...from].some((app) => !next.has(app)));
      const narrowed = takenActive && (drops(applied) || drops(takenApps));
      takenApps = next;
      takenActive = true;
      return narrowed ? raise({ narrowed: true }) : undefined;
    },
    /** The lease stream ended: the control is lost once what came before it applies. */
    lost: () => raise({ end: "lost" }),
    /** An update has been applied; its fence comes down. */
    release: (fence: Stopping | undefined) => {
      const at = fence === undefined ? -1 : fences.indexOf(fence);
      if (at >= 0) fences.splice(at, 1);
    },
    /** The strongest pending fence: an end, then a pause, an idle turn, a narrowed approval. */
    pending: (): Stopping | undefined =>
      fences.find((fence) => "end" in fence) ??
      fences.find((fence) => "pause" in fence) ??
      fences.find((fence) => "idle" in fence) ??
      fences.find((fence) => "narrowed" in fence),
    clear: () => fences.length === 0,
  };
}
