import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import {
  buildRuntimeInstructions,
  COMPUTER_USE_INSTRUCTION_SECTIONS,
} from "@goat/provider-core/server/runtimeInstructions";

import {
  GOAT_BROWSER_TOOL_INSTRUCTIONS,
  GOAT_ORCHESTRATION_SECTIONS,
} from "@goat/provider-core/server/orchestrationInstructions";
import { GOAT_DEVELOPMENT_INSTRUCTIONS } from "@goat/provider-core/server/developmentInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

const GOAT_DEVICE_TOOL_INSTRUCTIONS = `## GOAT devices

For iOS Simulator or Android Emulator work, run \`device.list\`, then \`device.open\` so the user can watch in their Device panel. Drive the device with the \`agent-device\` launcher path, host config, and session flags that \`device.open\` returns, on every command; prefer \`agent-device snapshot -i\` refs over coordinates, and use \`device.screenshot\` to see the screen. \`xcrun simctl\` and \`adb\` stay available for builds, logs, and anything else. If \`device.list\` reports a platform unavailable, say so.`;

export interface GoatToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
  /** The managed `cua-driver` MCP server is attached to this turn. */
  readonly computerUse?: boolean;
}

const normalizeAvailability = (
  availability: boolean | GoatToolAvailability,
): GoatToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Code mode defers nested MCP tools (openai/codex#32101), so it needs the two names spelled out. */
const CODEX_CODE_MODE_TOOLS =
  "In code mode, find GOAT tools with `tools.mcp__goat__goat_describe` and call them with `tools.mcp__goat__goat_call`.";

/**
 * Describing `preview_*` or `device_*` tools that aren't in the turn's tool list would be worse
 * than saying nothing: the instructions actively steer the model away from Playwright,
 * agent-browser, and raw simctl/adb, so leaving them in would talk it out of the only automation
 * it still has.
 */
const toolInstructions = (availability: boolean | GoatToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    CODEX_CODE_MODE_TOOLS,
    tools.browser ? GOAT_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? GOAT_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

/** Sent on every turn, with or without GOAT MCP; the discipline does not depend on GOAT's tools. */
export function buildCodexDevelopmentContext(): Record<
  string,
  V2TurnStartParams__AdditionalContextEntry
> {
  return { goat_code_development: { kind: "application", value: GOAT_DEVELOPMENT_INSTRUCTIONS } };
}

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | GoatToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...buildCodexDevelopmentContext(),
    ...Object.fromEntries(
      GOAT_ORCHESTRATION_SECTIONS.map((section, index) => [
        `goat_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    goat_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    // Its own entries keep the runtime entry and each skill section under the per-entry cap.
    ...(typeof toolsAvailable !== "boolean" && toolsAvailable.computerUse === true
      ? Object.fromEntries(
          COMPUTER_USE_INSTRUCTION_SECTIONS.map((section, index) => [
            `goat_code_runtime_computer_use_${String(index + 1).padStart(2, "0")}`,
            { kind: "application" as const, value: section },
          ]),
        )
      : {}),
    ...(tools ? { goat_code_tools: { kind: "application", value: tools } } : {}),
  };
}
