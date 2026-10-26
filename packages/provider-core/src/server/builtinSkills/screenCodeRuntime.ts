import { builtInSkillSections } from "./registry.ts";

export const SCREEN_CODE_INSTRUCTION_SECTIONS = builtInSkillSections(["screen-code"]);
const SCREEN_CODE_COMPACT_INSTRUCTIONS = "Screen: goat_screen_run";

/** The screen-code block `buildRuntimeInstructions` appends; empty when the turn lacks the skill. */
export function screenCodeRuntimeInstructions(runtime: {
  readonly screenCode: boolean;
  readonly screenCodeSkillPath?: string | undefined;
  readonly screenCodeCompact?: boolean | undefined;
}): string {
  if (!runtime.screenCode) return "";
  const pointer = runtime.screenCodeSkillPath
    ? ` Read the screen-code skill at ${runtime.screenCodeSkillPath.replaceAll(/\s+/g, " ").trim()} before the first cell.`
    : "";
  return runtime.screenCodeCompact && runtime.screenCodeSkillPath !== undefined
    ? `\n${SCREEN_CODE_COMPACT_INSTRUCTIONS}${pointer}`
    : `\n\n${SCREEN_CODE_INSTRUCTION_SECTIONS.join("\n\n")}${pointer}`;
}
