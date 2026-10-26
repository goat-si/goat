import { builtInSkillSections } from "./builtinSkills/registry.ts";

/**
 * Only useful with the GOAT MCP server, so it travels with the orchestration sections; an
 * adapter without them (Muse) appends it to its runtime text itself.
 */
export const GOAT_PULL_REQUEST_INSTRUCTIONS = `## GOAT pull requests

Link each PR you create, take over, or push to with goat_pull_request_link (full URL, each stack layer). If linking fails, say so. Skip PRs you only read or review. Call goat_pull_request_watch when asked to monitor, or when your work (a merge) waits on checks or reviews: push, then watch and end your turn. Otherwise act now or hand back. Children never watch, even if told to; their last line: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. Never poll or sleep. At handback, call goat_pull_request_unwatch.`;

/**
 * GOAT's built-in computer use skill for this host, attached only when the turn actually has the
 * `cua-driver` MCP server. Each section fits one Codex context entry.
 */
export const COMPUTER_USE_INSTRUCTION_SECTIONS = builtInSkillSections(["computer-use"]);
export const COMPUTER_USE_INSTRUCTIONS = COMPUTER_USE_INSTRUCTION_SECTIONS.join("\n\n");

/** Omit model and effort when the harness manages them dynamically. */
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
