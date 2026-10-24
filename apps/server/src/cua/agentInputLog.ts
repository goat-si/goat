/**
 * When agents' own input was on its way, so a person's input can be told apart from it
 * (#1235). The macOS helper sees only that the system had a keyboard or pointer event some time
 * ago; the driver posts its events through the same system state. An event is the agent's only
 * when one of the agent's calls that posts that kind of event was running then, or had just
 * answered. Time alone is not enough: a person's key during an agent's click is the person's.
 *
 * Every call that is not known to read counts as input, of the kinds its tool and arguments can
 * post; an unknown tool, a script or a batch posts both kinds. Tools that act through
 * accessibility alone post neither, so they never hide a person.
 *
 * @module agentInputLog
 */

export type InputKind = "keyboard" | "pointer";

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "check_permissions",
  "health_report",
  "get_guide",
  "list_apps",
  "list_windows",
  "get_accessibility_tree",
  "get_window_state",
  "get_screen_size",
  "get_cursor_position",
  "verify_state",
  "zoom",
  "start_session",
  "end_session",
  "get_session",
  "list_sessions",
  "get_agent_cursor_state",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
]);

/** Act through accessibility or window management; no keyboard or pointer events. */
const SEMANTIC_TOOLS: ReadonlySet<string> = new Set([
  "invoke_menu",
  "bring_to_front",
  "launch_app",
  "set_window_frame",
]);

const POINTER_TOOLS: ReadonlySet<string> = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "move_cursor",
]);

/** set_value can fall back to typing (a pop-up's type-ahead), so it counts as keyboard. */
const KEYBOARD_TOOLS: ReadonlySet<string> = new Set([
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
]);

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** The kinds of event a call can post: none for reads and accessibility-only tools. */
export function inputKinds(tool: string, args?: unknown): ReadonlyArray<InputKind> {
  if (READ_ONLY_TOOLS.has(tool) || SEMANTIC_TOOLS.has(tool)) return [];
  const given = record(args);
  // A point makes a keyboard tool click there first; modifiers make a pointer tool press keys.
  const point = typeof given?.x === "number" || typeof given?.y === "number";
  const modifiers = Array.isArray(given?.modifiers) && given.modifiers.length > 0;
  if (KEYBOARD_TOOLS.has(tool)) return point ? ["keyboard", "pointer"] : ["keyboard"];
  if (POINTER_TOOLS.has(tool)) return modifiers ? ["pointer", "keyboard"] : ["pointer"];
  return ["keyboard", "pointer"];
}

export const postsInput = (tool: string, args?: unknown) => inputKinds(tool, args).length > 0;

const BOTH: ReadonlyArray<InputKind> = ["keyboard", "pointer"];

/** An event this long before a call was sent is still a person's. */
const BEFORE_MS = 50;
/**
 * Events the driver posted can surface this long after its answer: the window server delivers
 * them after the call returns, and the helper polls every 250 ms.
 */
const AFTER_MS = 500;
/** Finished calls older than this can no longer cover an event the helper reports. */
const KEEP_MS = 10_000;
/**
 * An open call covers events for at most this long, and so does an unbroken run of calls of one
 * kind. Past it, a person's input of that kind pauses the agents even while calls keep coming: a
 * call that never answers, a lost end report, or back-to-back calls must not hide a person for
 * long. Agent input that really runs longer then pauses the agents, which errs toward the person.
 */
const OPEN_MS = 10_000;

interface Covered {
  readonly from: number;
  readonly to: number;
}

export function makeAgentInputLog() {
  const open = new Map<
    string,
    { readonly start: number; readonly kinds: ReadonlyArray<InputKind> }
  >();
  let done: Array<{
    readonly start: number;
    readonly end: number;
    readonly kinds: ReadonlyArray<InputKind>;
  }> = [];
  /**
   * Forgets what can no longer cover an event near now: finished calls after KEEP_MS, open ones
   * after OPEN_MS. A start whose end never arrives, or arrives first, is gone by then too. now
   * must come from the owner's own clock, never from a report, so a report dated in the future
   * cannot erase another agent's calls.
   */
  const prune = (now: number) => {
    done = done.filter((call) => now - call.end < KEEP_MS);
    for (const [key, call] of open) if (now - call.start > OPEN_MS) open.delete(key);
  };
  return {
    prune,
    started: (key: string, at: number, kinds: ReadonlyArray<InputKind> = BOTH) =>
      void open.set(key, { start: at, kinds }),
    /** A call answered, cancelled or cut off; true when it was open. */
    ended: (key: string, now: number) => {
      const call = open.get(key);
      if (call === undefined) return false;
      open.delete(key);
      done = [...done, { ...call, end: now }];
      return true;
    },
    /** Every open call ends, as when the driver child is stopped; returns their keys. */
    endAll: (now: number) => {
      const keys = [...open.keys()];
      for (const call of open.values()) done = [...done, { ...call, end: now }];
      open.clear();
      return keys;
    },
    /**
     * Whether an event of `kind` at `at` falls inside the agents' own input of that kind, for
     * no longer than OPEN_MS of unbroken cover. `live` says which open calls still count, so a
     * call of a control that has ended covers nothing. An event of unknown kind is a person's.
     */
    isAgents: (
      at: number,
      kind: InputKind | "unknown",
      live: (key: string) => boolean = () => true,
    ) => {
      if (kind === "unknown") return false;
      const spans: Array<Covered> = [
        ...[...open]
          .filter(([key, call]) => live(key) && call.kinds.includes(kind))
          .map(([, call]) => ({ from: call.start - BEFORE_MS, to: call.start + OPEN_MS })),
        ...done
          .filter((call) => call.kinds.includes(kind))
          .map((call) => ({ from: call.start - BEFORE_MS, to: call.end + AFTER_MS })),
      ];
      const covering = spans.filter((span) => at >= span.from && at <= span.to);
      if (covering.length === 0) return false;
      // Walk back through overlapping spans to where this run of cover began.
      let from = Math.min(...covering.map((span) => span.from));
      for (let grew = true; grew;) {
        grew = false;
        for (const span of spans)
          if (span.from < from && span.to >= from) {
            from = span.from;
            grew = true;
          }
      }
      return at - from <= OPEN_MS;
    },
    /** How many calls the log still holds, open or finished. */
    size: () => open.size + done.length,
  };
}
