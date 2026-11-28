import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { createModelCapabilities, createModelSelection } from "@goat/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  formatModelSelectionEffort,
  formatSubagentEffort,
  readSelectedEffortValue,
} from "./threadExecution.ts";

describe("formatModelSelectionEffort", () => {
  it("reads ACP thought_level and role: reasoning controls for cataloged and uncataloged models", () => {
    const models = [
      {
        slug: "gemini-4-neon",
        name: "Gemini 4 Neon",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            {
              id: "thought_level",
              label: "Thinking",
              type: "select",
              role: "reasoning",
              options: [
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
            },
          ],
        }),
      },
      {
        slug: "acp-custom-agent",
        name: "ACP Custom Agent",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            {
              id: "custom_thinking_mode",
              label: "Thinking",
              type: "select",
              role: "reasoning",
              options: [{ id: "deep", label: "Deep" }],
            },
          ],
        }),
      },
    ];
    const antigravitySelection = createModelSelection(
      ProviderInstanceId.make("antigravity"),
      "gemini-4-neon",
      [{ id: "thought_level", value: "high" }],
    );
    const customSelection = createModelSelection(
      ProviderInstanceId.make("acpRegistry"),
      "acp-custom-agent",
      [{ id: "custom_thinking_mode", value: "deep" }],
    );
    const uncatalogedSelection = createModelSelection(
      ProviderInstanceId.make("antigravity"),
      "gemini-4-neon-preview",
      [{ id: "thought_level", value: "high" }],
    );

    expect(formatModelSelectionEffort(antigravitySelection, models)).toBe("High");
    expect(formatModelSelectionEffort(customSelection, models)).toBe("Deep");
    expect(
      formatSubagentEffort({
        modelSlug: "gemini-4-neon-preview",
        modelSelection: uncatalogedSelection,
        provider: { driver: ProviderDriverKind.make("antigravity"), models },
      }),
    ).toBe("high");
    expect(
      readSelectedEffortValue(customSelection, models[1]?.capabilities?.optionDescriptors),
    ).toBe("deep");
  });
});
