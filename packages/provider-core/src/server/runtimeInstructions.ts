import { builtInSkillSections } from "./builtinSkills/registry.ts";

/**
 * Only useful with the GOAT MCP server, so it travels with the orchestration sections; an
 * adapter without them (Muse) appends it to its runtime text itself.
 */
export const GOAT_PULL_REQUEST_INSTRUCTIONS = `## GOAT pull requests

Register every pull request you create or work on, each layer of a stack included, with \`pull_request.link\` and its full URL; gh and other CLIs do not register it. Before finishing PR work, check \`pull_request.list\` and link what is missing, and report a failed link instead of claiming it. A delegated task returns PR URLs, head SHA, and check state to its parent instead of watching. Asked to monitor a PR, run \`pull_request.watch\` and end the turn; GOAT wakes you on its events. Run \`pull_request.unwatch\` when you hand the work back.`;

/**
 * GOAT's built-in computer use skill for this host, attached only when the turn actually has the
 * `cua-driver` MCP server. Each section fits one Codex context entry.
 */
export const COMPUTER_USE_INSTRUCTION_SECTIONS = builtInSkillSections(["computer-use"]);
export const COMPUTER_USE_INSTRUCTIONS = COMPUTER_USE_INSTRUCTION_SECTIONS.join("\n\n");

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** True when this turn carries the computer use skill (see `resolveBuiltInSkills`). */
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
