import type { Handoff } from "@goat/contracts";

/** What a computer use request card says once a person has answered it. */
export function computerUseGrantLabel(
  handoff: Pick<Handoff, "state" | "resolvedBy" | "computerUseForeground">,
  liveUntil: Date | null,
): string {
  const by = handoff.resolvedBy ? ` by ${handoff.resolvedBy}` : "";
  if (liveUntil !== null) {
    const delivery =
      handoff.computerUseForeground === undefined
        ? "Background delivery only."
        : "Foreground was approved; pause, Stop or finishing this turn requires new approval.";
    return `Allowed until ${liveUntil.toLocaleTimeString()}${by}. ${delivery}`;
  }
  if (handoff.state === "completed") return "Ended at its time limit";
  if (handoff.state === "cancelled") return `Ended${by}`;
  if (handoff.state === "declined") return `Declined${by}`;
  return "Expired";
}
