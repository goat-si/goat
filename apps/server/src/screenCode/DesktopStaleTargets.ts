import type { BoundWindow } from "./DesktopTargetHost.ts";
import type { ScreenObservations } from "./ScreenObservations.ts";
import { fail } from "./DesktopDriverReplies.ts";

const PERSON_HOLDS = new Set(["pause", "takeover", "private", "waiting_for_human"]);

export const staleTargets = (
  targets: Map<string, BoundWindow>,
  observations: ScreenObservations,
) => {
  const dropped = new Map<
    string,
    { bundleId: string | undefined; windowId: number; reason: string }
  >();
  const dropTarget = (targetId: string, reason: string) => {
    const bound = targets.get(targetId);
    if (bound) {
      if (dropped.size >= 4096) {
        const oldest = dropped.keys().next().value;
        if (oldest !== undefined) dropped.delete(oldest);
      }
      dropped.set(targetId, { bundleId: bound.bundleId, windowId: bound.windowId, reason });
    }
    observations.evictTarget(targetId);
    targets.delete(targetId);
  };
  const staleTargetStep = (targetId: string, override?: string) => {
    const bound = targets.get(targetId);
    const entry =
      dropped.get(targetId) ??
      (bound && { bundleId: bound.bundleId, windowId: bound.windowId, reason: "invalidated" });
    if (!entry) return undefined;
    const why = override ?? entry.reason;
    const reason =
      why === "permission_denied" || why === "credentialRevoked"
        ? "Permission was lost."
        : why === "turn_ended"
          ? "The target was bound in an earlier turn."
          : why === "different_run"
            ? "The target was bound in a different run."
            : why === "different_environment"
              ? "The target was bound in a different environment."
              : why === "replaced"
                ? "The window was replaced by another binding."
                : why === "invalidated"
                  ? "The target was invalidated."
                  : `The control changed (${why}).`;
    const rebind =
      entry.bundleId === undefined
        ? "Use screen.discover() to find the window and bind it again."
        : `Rebind with screen.app({ bundle_id: ${JSON.stringify(entry.bundleId)}, window_id: ${entry.windowId} }).`;
    // The person holds the app now; binding again before they hand it back would be refused.
    if (PERSON_HOLDS.has(why))
      return `The person took control (${why}). Wait until they hand it back, then: ${rebind}`;
    return `${reason} ${rebind}`;
  };
  const staleTarget = (targetId: string | undefined) =>
    fail("stale_reference", targetId === undefined ? undefined : staleTargetStep(targetId));
  return { dropTarget, staleTargetStep, staleTarget };
};
