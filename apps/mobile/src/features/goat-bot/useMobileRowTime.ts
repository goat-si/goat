import { minuteTick } from "@goat/client-runtime/clock";
import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const UNIT_WORDS = { m: "minute", h: "hour", d: "day" } as const;
const notTicking = () => () => {};

/**
 * A work row's time in the words web's Home rows use: "now", "5m", "2h", "3d" (apps/web
 * RelativeTimeLabel over formatRelativeElapsed). The two scales must stay equal.
 */
export function mobileRowTime(timestamp: string, nowMs: number): string {
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return "";
  const elapsedMs = Math.max(0, nowMs - at);
  if (elapsedMs < MINUTE_MS) return "now";
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m`;
  if (elapsedMs < DAY_MS) return `${Math.floor(elapsedMs / HOUR_MS)}h`;
  return `${Math.floor(elapsedMs / DAY_MS)}d`;
}

/** The same time as a screen reader should say it: "just now", "5 minutes ago". */
export function mobileRowTimeSpoken(time: string): string {
  if (time === "now") return "just now";
  const match = /^(\d+)([mhd])$/.exec(time);
  if (!match) return "";
  const count = Number(match[1]);
  return `${count} ${UNIT_WORDS[match[2] as keyof typeof UNIT_WORDS]}${count === 1 ? "" : "s"} ago`;
}

/**
 * A row's time. It follows the shared minute clock only while `ticking` (Home shown, the app
 * active), so a hidden Home or a backgrounded app keeps no row awake; the snapshot is the row's own
 * text, so a row re-renders only when that text changes. It reads the wall clock, not the clock's
 * cached minute, which another subscriber can hold stale after the app was suspended.
 */
export function useMobileRowTime(timestamp: string, ticking: boolean): string {
  const read = () => mobileRowTime(timestamp, Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS);
  return useSyncExternalStore(ticking ? minuteTick.subscribe : notTicking, read, read);
}
