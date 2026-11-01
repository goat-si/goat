import type { ScreenRunError } from "@goat/contracts";

/** Tab input checks the host makes before the browser sees anything: each answer is unsent. */

const fail = (code: ScreenRunError["code"], nextStep: string): ScreenRunError => ({
  code,
  effectStarted: false,
  nextStep,
});

export const WEB_ONLY =
  "Browser tabs only open http(s) URLs; serve local files over http://127.0.0.1.";

/**
 * A URL with a scheme other than http(s). "localhost:3000" and "example.com:8080" read as a
 * scheme too, so a dotted or localhost name followed by a port alone is a host the browser
 * completes; tel:123 or javascript:123 are not.
 */
export const nonWebUrl = (url: unknown): boolean => {
  if (typeof url !== "string") return false;
  const match = /^([a-z][a-z0-9+.-]*):(.*)$/is.exec(url.trim());
  if (!match) return false;
  const scheme = (match[1] ?? "").toLowerCase();
  if (scheme === "http" || scheme === "https") return false;
  const host = scheme === "localhost" || scheme.includes(".");
  return !(host && /^\d+([/?#].*)?$/s.test(match[2] ?? ""));
};

const STATES = new Set(["attached", "detached", "visible", "hidden"]);

/** A tab wait's element conditions, forwarded only when well typed; a dropped one would lie. */
export const waitConditions = (
  arg: Record<string, unknown>,
): { readonly fields: Record<string, unknown> } | { readonly error: ScreenRunError } => {
  const fields: Record<string, unknown> = {};
  for (const key of ["enabled", "checked", "selected"] as const) {
    if (arg[key] === undefined) continue;
    if (typeof arg[key] !== "boolean")
      return { error: fail("invalid_argument", `${key} is true or false.`) };
    fields[key] = arg[key];
  }
  if (arg.value !== undefined) {
    if (typeof arg.value !== "string")
      return { error: fail("invalid_argument", "value is a string.") };
    fields.value = arg.value;
  }
  if (arg.state !== undefined) {
    if (typeof arg.state !== "string" || !STATES.has(arg.state))
      return { error: fail("invalid_argument", "state is attached, detached, visible or hidden.") };
    fields.state = arg.state;
  }
  return { fields };
};

const CLICK_WAIT_MS = 5_000;
// What a tab click or hover reads from its call; any other key would be dropped unseen.
const POINTER_KEYS = new Set([
  "targetRef",
  "selector",
  "ref",
  "point",
  "x",
  "y",
  "count",
  "timeoutMs",
  "batch",
]);
// The browser's answer still has to reach the cell after the click gave up on its target.
const ANSWER_RESERVE_MS = 500;
const MIN_POINTER_MS = 250;

/** How long a tab click or hover may wait for its target: 5 s unless asked, never past the cell. */
const pointerTimeout = (
  requested: unknown,
  deadlineMillis: number,
  now: number,
): { readonly timeoutMs: number } | { readonly error: ScreenRunError } => {
  if (requested !== undefined && !(Number.isInteger(requested) && Number(requested) > 0))
    return {
      error: fail("invalid_argument", "timeoutMs is a whole number of milliseconds above 0."),
    };
  const room = deadlineMillis - now - ANSWER_RESERVE_MS;
  if (room < MIN_POINTER_MS)
    return {
      error: fail("deadline", "Too little of this cell is left for this input; act in a new cell."),
    };
  return { timeoutMs: Math.min(typeof requested === "number" ? requested : CLICK_WAIT_MS, room) };
};

/**
 * A tab click's or hover's browser input: its target (a locator, or a resolved screenshot point),
 * a click's button and count (1 to 3), and how long it waits for the target; checked unsent.
 */
export const pointerInput = (
  method: string,
  arg: Record<string, unknown>,
  target: string | { readonly x: number; readonly y: number } | undefined,
  deadlineMillis: number,
  now: number,
): { readonly fields: Record<string, unknown> } | { readonly error: ScreenRunError } => {
  if (target === undefined)
    return { error: fail("invalid_argument", "Use a current element or image point.") };
  const unknown = Object.keys(arg).find((key) => !POINTER_KEYS.has(key));
  if (unknown !== undefined)
    return {
      error: fail(
        "invalid_argument",
        `A tab ${method === "hover" ? "hover" : "click"} does not take ${unknown}${
          unknown === "clickCount" || unknown === "clicks" ? "; its click count is count" : ""
        }. It takes a selector, ref or point, count and timeoutMs.`,
      ),
    };
  const count = method === "hover" ? undefined : arg.count;
  if (count !== undefined && !(Number.isInteger(count) && Number(count) >= 1 && Number(count) <= 3))
    return { error: fail("invalid_argument", "A tab click count is 1, 2 or 3.") };
  const wait = pointerTimeout(arg.timeoutMs, deadlineMillis, now);
  if ("error" in wait) return wait;
  return {
    fields: {
      ...(typeof target === "string" ? { locator: target } : { x: target.x, y: target.y }),
      ...(method === "right_click" ? { button: "right" } : {}),
      ...(count === undefined ? {} : { clickCount: count }),
      timeoutMs: wait.timeoutMs,
    },
  };
};
