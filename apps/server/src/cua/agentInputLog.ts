/**
 * When agents' own input was on its way, so a person's input can be told apart from it
 * (#1235). The macOS helper sees only that the system had a keyboard or pointer event some time
 * ago; the driver posts its events through the same system state, so an event inside one of the
 * agent's input calls, or just after it, is the agent's.
 *
 * Every call counts as input except the ones known only to read. An unknown tool is treated as
 * input, so a new driver tool can hide a person's input during its own call but never pause the
 * agent for its own events.
 *
 * @module agentInputLog
 */

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

export const postsInput = (tool: string) => !READ_ONLY_TOOLS.has(tool);

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
 * An open call covers events for at most this long. Past it, a person's input pauses the agents
 * even while a call is still open: a call that never answers, or whose end report was lost, must
 * not hide a person for long. An input call that really runs longer, such as a long script, then
 * pauses the agents for its own input, which errs toward the person. The proxy does not know a
 * call's own deadline, so this is a fixed bound.
 */
const OPEN_MS = 10_000;

export function makeAgentInputLog() {
  const open = new Map<string, number>();
  let done: Array<{ readonly start: number; readonly end: number }> = [];
  /**
   * Forgets what can no longer cover an event near now: finished calls after KEEP_MS, open ones
   * after OPEN_MS. A start whose end never arrives, or arrives first, is gone by then too. now
   * must come from the owner's own clock, never from a report, so a report dated in the future
   * cannot erase another agent's calls.
   */
  const prune = (now: number) => {
    done = done.filter((call) => now - call.end < KEEP_MS);
    for (const [key, start] of open) if (now - start > OPEN_MS) open.delete(key);
  };
  const finish = (start: number, end: number) => {
    done = [...done, { start, end }];
  };
  return {
    prune,
    started: (key: string, at: number) => void open.set(key, at),
    /** A call answered, cancelled or cut off; true when it was open. */
    ended: (key: string, now: number) => {
      const start = open.get(key);
      if (start === undefined) return false;
      open.delete(key);
      finish(start, now);
      return true;
    },
    /** Every open call ends, as when the driver child is stopped; returns their keys. */
    endAll: (now: number) => {
      const keys = [...open.keys()];
      for (const start of open.values()) finish(start, now);
      open.clear();
      return keys;
    },
    /**
     * Whether an event at `at` falls inside an agent's input. `live` says which open calls still
     * count, so a call of a control that has ended covers nothing.
     */
    isAgents: (at: number, live: (key: string) => boolean = () => true) =>
      [...open].some(
        ([key, start]) => live(key) && at >= start - BEFORE_MS && at <= start + OPEN_MS,
      ) || done.some((call) => at >= call.start - BEFORE_MS && at <= call.end + AFTER_MS),
    /** How many calls the log still holds, open or finished. */
    size: () => open.size + done.length,
  };
}
