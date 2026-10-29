/**
 * Whether a pid-scoped list_windows reply proves a window closed. Closed means the window was no
 * longer one of that pid's WindowServer windows at snapshot time (also when the process exited);
 * it says nothing about why, and a reused pid or a later reopen is the caller's to rule out.
 */

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const windowId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export type WindowClosure = "closed" | "present" | "unproven";

export const windowClosure = (value: unknown, pid: number, target: number): WindowClosure => {
  const reply = record(value);
  const ids = reply?.authoritative_window_ids;
  if (reply?.enumeration_complete !== true || !Array.isArray(ids) || !ids.every(windowId))
    return "unproven";
  if (ids.includes(target)) return "present";
  // The listing and the id snapshot are read separately; an entry the listing cannot be read
  // from could be the window, and a listed window the ids omit is a contradiction.
  const listed = reply.windows;
  if (!Array.isArray(listed)) return "unproven";
  for (const item of listed) {
    const entry = record(item);
    if (!entry || !windowId(entry.window_id)) return "unproven";
    if (entry.pid !== undefined && !Number.isSafeInteger(entry.pid)) return "unproven";
    if (entry.window_id === target && (entry.pid ?? pid) === pid) return "unproven";
  }
  return "closed";
};
