/**
 * Only useful with the GOAT MCP server, so it travels with the orchestration sections; an
 * adapter without them (Muse) appends it to its runtime text itself.
 */
export const GOAT_PULL_REQUEST_INSTRUCTIONS = `## GOAT pull requests

Register every pull request you create or work on, each layer of a stack included, with \`pull_request.link\` and its full URL; gh and other CLIs do not register it. Before finishing PR work, check \`pull_request.list\` and link what is missing, and report a failed link instead of claiming it. A delegated task returns PR URLs, head SHA, and check state to its parent instead of watching. Asked to monitor a PR, run \`pull_request.watch\` and end the turn; GOAT wakes you on its events. Run \`pull_request.unwatch\` when you hand the work back.`;

/**
 * Only attached when the session actually has the `cua-driver` MCP server.
 * The user shares the screen with the agent, so foreground delivery steals
 * focus and windows the agent leaves open hide the thread they are watching.
 */
export const COMPUTER_USE_INSTRUCTIONS = `<computer_use>
The cua-driver MCP tools control the computer the user is working on right now. Use them only for work that needs an app's GUI; when shell commands, other MCP tools, or the goat preview tools can do the task, use those instead. Every input tool (click, type_text, press_key, hotkey, scroll, drag, ...) defaults to delivery_mode "background", which acts on the target window without raising it or taking focus. Keep that default. Pass delivery_mode "foreground" only after a background action reported that it did not land, and never call bring_to_front just to look at a window: get_window_state captures it without activating it. Target windows by pid and window id rather than by what is frontmost. When the task is done, leave the desktop as you found it: close windows you opened, do not close windows the user had open, and restore the window that was active before you started so the user can see your reply.
</computer_use>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** True when this session's tool list includes the managed `cua-driver` MCP server. */
  readonly computerUse?: boolean | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const computerUse = runtime.computerUse ? `\n\n${COMPUTER_USE_INSTRUCTIONS}` : "";
  return `<runtime_info>You run in GOAT through the ${harness} harness${modelInfo}${effortInfo}; say so only if asked. Markdown can embed images and videos by absolute file path.</runtime_info>${computerUse}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
