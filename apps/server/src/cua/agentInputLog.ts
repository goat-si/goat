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

/**
 * Whether a move_cursor moves the real pointer under pinned cua-driver 0.37.0
 * (normalize_action_target): only a desktop move with no window selector. Any other form moves
 * only GOAT's overlay, or is refused before it runs: legacy desktop scope with a pid or window_id
 * becomes a window move (Linux) or a refusal, and a typed target beside any legacy field, or one
 * the driver does not accept, is refused. Keys count when present, as the driver checks them.
 */
const movesPointer = (given: Readonly<Record<string, unknown>> | undefined) => {
  const has = (key: string) => given !== undefined && key in given;
  if (has("target")) {
    if (has("scope") || has("pid") || has("window_id")) return false;
    const target = record(given?.target);
    return (
      target?.kind === "desktop" &&
      target.display_id === "primary" &&
      Object.keys(target).length === 2
    );
  }
  return given?.scope === "desktop" && !has("pid") && !has("window_id");
};

/** The kinds of event a call can post: none for reads and accessibility-only tools. */
export function inputKinds(tool: string, args?: unknown): ReadonlyArray<InputKind> {
  if (READ_ONLY_TOOLS.has(tool) || SEMANTIC_TOOLS.has(tool)) return [];
  const given = record(args);
  if (tool === "move_cursor" && !movesPointer(given)) return [];
  // A point makes a keyboard tool click there first; modifiers make a pointer tool press keys.
  const point = typeof given?.x === "number" || typeof given?.y === "number";
  // click, right_click and drag name their held keys `modifier`.
  const held = given?.modifier ?? given?.modifiers;
  const modifiers = Array.isArray(held) && held.length > 0;
  if (KEYBOARD_TOOLS.has(tool)) return point ? ["keyboard", "pointer"] : ["keyboard"];
  // With a point or an element, scroll turns the wheel there; with neither it presses Page Down
  // or arrows in the focused element.
  if (tool === "scroll")
    return point || given?.element_token !== undefined ? ["pointer"] : ["keyboard"];
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
/**
 * How long after the end of its cover a call is remembered, and so the oldest event the server
 * can still judge: one older than this may have been covered by a call already forgotten.
 */
export const KEEP_MS = 10_000;
/**
 * An open call covers events for at most this long, and so does an unbroken run of calls of one
 * kind. Past it, a person's input of that kind pauses the agents even while calls keep coming: a
 * call that never answers, a lost end report, or back-to-back calls must not hide a person for
 * long. Agent input that really runs longer then pauses the agents, which errs toward the person.
 */
const OPEN_MS = 10_000;

/** One call's cover of one kind: from just before it began until its tail, open while it runs. */
interface Span {
  readonly key: string | undefined;
  readonly from: number;
  to: number;
}

/**
 * Groups spans into unbroken runs, earliest first. Calls reach the log in the order their reports
 * arrive, which across controls is not the order they began, so runs are found from the spans
 * each time rather than kept as they grow.
 */
function runsOf(spans: ReadonlyArray<Span>): Array<Array<Span>> {
  const sorted = [...spans].sort((left, right) => left.from - right.from);
  const runs: Array<Array<Span>> = [];
  let reach = -Infinity;
  for (const span of sorted) {
    const current = runs.at(-1);
    if (current !== undefined && span.from <= reach) current.push(span);
    else runs.push([span]);
    reach = current !== undefined && span.from <= reach ? Math.max(reach, span.to) : span.to;
  }
  return runs;
}

/**
 * Keeps a run's history short: closed spans that end before every open span of their run cannot
 * have a gap an open span bridges, so together they are one span. A run with nothing open is one
 * span. The earliest start of every run is kept.
 */
function compact(spans: ReadonlyArray<Span>): Array<Span> {
  return runsOf(spans).flatMap((run) => {
    const firstOpen = Math.min(
      ...run.filter((span) => span.to === Infinity).map((span) => span.from),
    );
    const settled = run.filter((span) => span.to < firstOpen);
    if (settled.length < 2) return run;
    return [
      {
        key: undefined,
        from: Math.min(...settled.map((span) => span.from)),
        to: Math.max(...settled.map((span) => span.to)),
      },
      ...run.filter((span) => span.to >= firstOpen),
    ];
  });
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
    /** Set for an open call kept after its 10 s: it covers only while its control is live. */
    readonly expired?: string;
  }> = [];
  /**
   * Each kind's spans, kept apart from the calls themselves: forgetting an old call must not make
   * a long run look as if it began later.
   */
  const spans: Record<InputKind, Array<Span>> = { keyboard: [], pointer: [] };
  const opened = (key: string, kinds: ReadonlyArray<InputKind>, at: number) => {
    for (const kind of kinds) spans[kind].push({ key, from: at - BEFORE_MS, to: Infinity });
  };
  const closed = (key: string, kinds: ReadonlyArray<InputKind>, until: number) => {
    for (const kind of kinds) {
      const span = spans[kind].find((entry) => entry.key === key && entry.to === Infinity);
      if (span !== undefined) span.to = until;
      spans[kind] = compact(spans[kind]);
    }
  };
  const finish = (
    key: string,
    call: { readonly start: number; readonly kinds: ReadonlyArray<InputKind> },
    end: number,
  ) => {
    done = [...done, { ...call, end }];
    closed(key, call.kinds, end + AFTER_MS);
  };
  /**
   * Forgets what can no longer cover an event near now: finished calls KEEP_MS after their
   * cover ends, open ones after OPEN_MS (kept as finished at that point), and runs that ended
   * that long ago. A start whose end never arrives, or arrives
   * first, is gone by then too. now must come from the owner's own clock, never from a report, so
   * a report dated in the future cannot erase another agent's calls.
   */
  const prune = (now: number) => {
    for (const [key, call] of open)
      if (now - call.start > OPEN_MS) {
        open.delete(key);
        // It covered until start + OPEN_MS and still does for events from then.
        done = [...done, { ...call, end: call.start + OPEN_MS - AFTER_MS, expired: key }];
        closed(key, call.kinds, call.start + OPEN_MS);
      }
    // Kept until KEEP_MS past the end of each call's cover, so every event remembers() admits
    // is judged against every call that could have covered it.
    done = done.filter((call) => now - (call.end + AFTER_MS) < KEEP_MS);
    for (const kind of ["keyboard", "pointer"] as const)
      spans[kind] = runsOf(spans[kind])
        .filter((run) => now - Math.max(...run.map((span) => span.to)) < KEEP_MS)
        .flat();
  };
  return {
    prune,
    /** Whether the log still holds every call that could cover an event at "at". */
    remembers: (at: number, now: number) => now - at < KEEP_MS,
    started: (key: string, at: number, kinds: ReadonlyArray<InputKind> = BOTH) => {
      // A repeated start for one call ends the earlier record first, so every open has its close.
      const earlier = open.get(key);
      if (earlier !== undefined) finish(key, earlier, at);
      open.set(key, { start: at, kinds });
      opened(key, kinds, at);
    },
    /** A call answered, cancelled or cut off; true when it was open. */
    ended: (key: string, now: number) => {
      const call = open.get(key);
      if (call === undefined) return false;
      open.delete(key);
      finish(key, call, now);
      return true;
    },
    /** Every open call ends, as when the driver child is stopped; returns their keys. */
    endAll: (now: number) => {
      const keys = [...open.keys()];
      for (const [key, call] of open) finish(key, call, now);
      open.clear();
      return keys;
    },
    /**
     * Whether an event of `kind` at `at` falls inside the agents' own input of that kind, for
     * no longer than OPEN_MS into an unbroken run. `live` says which open calls still count, so
     * a call of a control that has ended covers nothing. An event of unknown kind is a person's.
     */
    isAgents: (
      at: number,
      kind: InputKind | "unknown",
      live: (key: string) => boolean = () => true,
    ) => {
      if (kind === "unknown") return false;
      const covered =
        [...open].some(
          ([key, call]) =>
            live(key) &&
            call.kinds.includes(kind) &&
            at >= call.start - BEFORE_MS &&
            at <= call.start + OPEN_MS,
        ) ||
        done.some(
          (call) =>
            (call.expired === undefined || live(call.expired)) &&
            call.kinds.includes(kind) &&
            at >= call.start - BEFORE_MS &&
            at <= call.end + AFTER_MS,
        );
      if (!covered) return false;
      const run = runsOf(spans[kind]).find(
        (entry) =>
          Math.min(...entry.map((span) => span.from)) <= at &&
          at <= Math.max(...entry.map((span) => span.to)),
      );
      // No run on record for covered input: err toward the person.
      return run !== undefined && at - Math.min(...run.map((span) => span.from)) <= OPEN_MS;
    },
    /** How many calls the log still holds, open or finished. */
    size: () => open.size + done.length,
  };
}
