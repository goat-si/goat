import { builtInSkillSections } from "./builtinSkills/registry.ts";

/**
 * Only useful with the GOAT MCP server, so it travels with the orchestration sections; an
 * adapter without them (Muse) appends it to its runtime text itself.
 */
export const GOAT_PULL_REQUEST_INSTRUCTIONS = `## GOAT pull requests

Link each PR you create, take over, or push to: one goat_pull_request_link per PR, full URL, every stack layer, as your next call. CLIs do not link for you. If linking fails, say so. Skip PRs you only read or review, or background PRs. Call goat_pull_request_watch when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Update and push the branch first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. Never wait with sleep, loops, or gh --watch. At handback, call goat_pull_request_unwatch for watched PRs.`;

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
