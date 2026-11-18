export const RECONNECT_ATTEMPTS = 5;
export const RECONNECT_DELAY = "2 seconds";
export const RECONCILE_TIMEOUT = "15 seconds";
export const RECONNECT_WAIT = "30 seconds";
export const LOST_BACKGROUND =
  "GOAT lost its connection to OpenCode while this subagent ran, so its result is not shown.";
export const INVENTORY_TIMEOUT = "5 seconds";
export const ACTIVE_CHECK_TIMEOUT = "5 seconds";

// Other failures may still have admitted the prompt.
export const CLEAR_PROMPT_REJECTIONS: ReadonlySet<string> = new Set([
  "InvalidRequestError",
  "ConflictError",
  "UnauthorizedError",
  "CommandNotFoundError",
  "SkillNotFoundError",
]);
