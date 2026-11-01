import type { Wakeups } from "@goat/client-runtime/connection";

export const MOBILE_LONG_BACKGROUND_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-long"
>;

export function mobileApplicationActiveWakeup(
  backgroundedAtMs: number | null,
  activeAtMs: number,
  foregroundHandoffActive = false,
): MobileApplicationActiveWakeup {
  return !foregroundHandoffActive &&
    backgroundedAtMs !== null &&
    activeAtMs - backgroundedAtMs >= MOBILE_LONG_BACKGROUND_AFTER_MS
    ? "application-active-long"
    : "application-active-probe";
}
