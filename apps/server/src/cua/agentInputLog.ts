/**
 * When the agent's own input was on its way, so a person's input can be told apart from it
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

export function makeAgentInputLog() {
  const open = new Map<string, number>();
  let done: Array<{ readonly start: number; readonly end: number }> = [];
  const finish = (start: number, now: number) => {
    done = [...done.filter((call) => now - call.end < KEEP_MS), { start, end: now }];
  };
  return {
    started: (key: string, now: number) => void open.set(key, now),
    /** A call answered, cancelled or cut off; unknown keys are ignored. */
    ended: (key: string, now: number) => {
      const start = open.get(key);
      if (start === undefined) return;
      open.delete(key);
      finish(start, now);
    },
    /** Every open call ends, as when the driver child is stopped. */
    endAll: (now: number) => {
      for (const start of open.values()) finish(start, now);
      open.clear();
    },
    /** Whether an event at `at` falls inside the agent's own input. */
    isAgents: (at: number) =>
      [...open.values()].some((start) => at >= start - BEFORE_MS) ||
      done.some((call) => at >= call.start - BEFORE_MS && at <= call.end + AFTER_MS),
  };
}
