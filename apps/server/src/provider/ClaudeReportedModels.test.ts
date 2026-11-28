import { assert, expect, it } from "vite-plus/test";
import { BUNDLED_CLAUDE_MODEL_CATALOG, type ClaudeModelCatalog } from "./ClaudeModelCatalog.ts";
import { claudeReportedModels } from "./ClaudeReportedModels.ts";

const syntheticCatalog: ClaudeModelCatalog = {
  models: [
    {
      model: {
        slug: "claude-synthetic-next",
        name: "Synthetic Next",
        aliases: ["synthetic"],
        isCustom: false,
        capabilities: null,
      },
      runtime: {},
      compatibility: {},
    },
  ],
};

it("merges discovered models without duplicating aliases or custom models", () => {
  const { models, hasNonCatalogModels } = claudeReportedModels(
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
  expect(hasNonCatalogModels).toBe(true);
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

it("counts a configured gateway alias as reported even when it resolves to a catalog model", () => {
  const reported = [
    {
      value: "gateway/current[1m]",
      resolvedModel: "claude-synthetic-next",
      displayName: "Current",
      description: "",
    },
  ];

  assert.deepStrictEqual(claudeReportedModels(syntheticCatalog, ["GATEWAY/current"], reported), {
    models: [],
    hasNonCatalogModels: true,
  });
  assert.deepStrictEqual(claudeReportedModels(syntheticCatalog, [], reported), {
    models: [],
    hasNonCatalogModels: false,
  });
});

it.each([
  ["synthetic", "gateway/current", ["synthetic"], true],
  ["synthetic", "gateway/current", ["gateway/current"], true],
  ["synthetic", "gateway/current", [], false],
  ["synthetic", "", ["synthetic"], false],
  ["synthetic", "SYNTHETIC[1m]", ["synthetic"], false],
  ["synthetic", "claude-synthetic-next", ["synthetic"], false],
  ["synthetic", "global.anthropic.claude-synthetic-next-v1:0[1m]", ["synthetic"], false],
  ["sonnet", "gateway/current", ["sonnet"], false],
  ["sonnet", "gateway/current", ["gateway/current"], false],
  ["sonnet", "global.anthropic.claude-sonnet-5-5[1m]", ["sonnet"], false],
])(
  "checks gateway inventory for %s resolving to %s with custom models %j",
  (value, resolvedModel, customModels, hasNonCatalogModels) => {
    const catalog = value === "sonnet" ? BUNDLED_CLAUDE_MODEL_CATALOG : syntheticCatalog;
    const reported = [{ value, resolvedModel, displayName: "", description: "" }];

    assert.deepStrictEqual(claudeReportedModels(catalog, customModels, reported), {
      models: [],
      hasNonCatalogModels,
    });
  },
);
