import type { Handoff } from "@goat/contracts";

/** What a computer use request card says once a person has answered it. */
export function computerUseGrantLabel(
  handoff: Pick<Handoff, "state" | "resolvedBy">,
  liveUntil: Date | null,
): string {
  const by = handoff.resolvedBy ? ` by ${handoff.resolvedBy}` : "";
  if (liveUntil !== null) return `Allowed until ${liveUntil.toLocaleTimeString()}${by}`;
  if (handoff.state === "completed") return "Ended at its time limit";
  if (handoff.state === "cancelled") return `Ended${by}`;
  if (handoff.state === "declined") return `Declined${by}`;
  return "Expired";
}
