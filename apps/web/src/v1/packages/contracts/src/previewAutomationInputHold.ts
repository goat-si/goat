/**
 * Page global holding the time (ms since epoch) until which the server holds a preview tab's input
 * after Stop or a secret cut an agent action. The desktop relay checks it after its own focus wait,
 * right before inserting text.
 */
export const PREVIEW_AGENT_INPUT_HELD_GLOBAL = "__goatAgentInputHeld";
/** Longest a hold lasts if its release never reaches the page; agent dispatch takes far less. */
export const PREVIEW_AGENT_INPUT_HOLD_MAX_MS = 5_000;
