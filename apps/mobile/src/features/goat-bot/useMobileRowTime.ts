import { minuteTick } from "@goat/client-runtime/clock";
import { goatBotRowTime } from "@goat/client-runtime/goatBot";
import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;
// Joins the compact and spoken forms into one string snapshot; neither form contains it.
const SEPARATOR = "\u0000";
const notTicking = () => () => {};

/**
 * A row's time, compact for the eye and in words for a screen reader (goatBotRowTime, shared with
 * web). It follows the shared minute clock only while `ticking` (Home shown, the app active), and a
 * row re-renders only when its words change. It reads the wall clock, not the clock's cached
 * minute, which another subscriber can hold stale after the app was suspended.
 */
export function useMobileRowTime(
  timestamp: string,
  ticking: boolean,
): { readonly text: string; readonly spoken: string } {
  const read = () => {
    const time = goatBotRowTime(timestamp, Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS);
    return time === null ? "" : time.text + SEPARATOR + time.spoken;
  };
  const snapshot = useSyncExternalStore(ticking ? minuteTick.subscribe : notTicking, read, read);
  const [text = "", spoken = ""] = snapshot.split(SEPARATOR);
  return { text, spoken };
}
