import { expect, it } from "vite-plus/test";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "./ClaudeModelCatalog.ts";
import { claudeReportedModels } from "./ClaudeReportedModels.ts";

it("merges discovered models without duplicating aliases or custom models", () => {
  const models = claudeReportedModels(
    BUNDLED_CLAUDE_MODEL_CATALOG,
    [{ slug: "gateway/custom[1m]", name: "Mine" }],
    [
      { value: "default", displayName: "Default", description: "" },
      { value: "sonnet", displayName: "Sonnet", description: "" },
      { value: "gateway/custom", displayName: "Custom", description: "" },
      {
        value: "gateway/new[1m]",
        displayName: "New",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
      { value: "gateway/new", displayName: "Duplicate", description: "" },
    ],
  );
  expect(models.map((model) => model.slug)).toEqual(["gateway/new[1m]"]);
  expect(models[0]?.capabilities?.optionDescriptors).toEqual([
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "default", label: "Default", isDefault: true },
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
  ]);
});
