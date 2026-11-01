import { assert, describe, it, vi } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";

import { resolveProviderCatalog, type ModelManifestData } from "./ModelManifest.ts";
import {
  formatClaudeVersionUpgradeMessage,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  resolveClaudeUpdateRequiredModels,
  scopeClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";

const manifest = (): ModelManifestData => ({
  version: 1,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "extreme", label: "Extreme", isDefault: true }],
              },
              {
                id: "contextWindow",
                label: "Context Window",
                type: "select",
                options: [
                  { id: "large", label: "Large", isDefault: true },
                  { id: "small", label: "Small" },
                ],
              },
            ],
          },
          adapter: {
            claudeCode: {
              effortMap: { extreme: "high" },
              modelSuffixes: { contextWindow: { large: "[large]" } },
            },
          },
        },
      },
      models: [
        {
          slug: "claude-synthetic-next",
          name: "Claude Synthetic Next",
          aliases: ["synthetic"],
          status: "current",
          profile: "synthetic",
          adapter: { claudeCode: { minVersion: "3.2.0" } },
        },
      ],
    },
  },
});

const CLAUDE = ProviderDriverKind.make("claudeAgent");

const catalogFromManifest = (data: ModelManifestData) =>
  resolveClaudeModelCatalog(resolveProviderCatalog(data, CLAUDE) ?? undefined);

describe("Claude model catalog", () => {
  it.each(["missing", "invalid"] as const)(
    "expires bundled badges offline when the supplied catalog is %s",
    (source) => {
      using now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-07T00:00:00Z"));
      const catalog = resolveProviderCatalog(manifest(), CLAUDE)!;
      const input =
        source === "missing"
          ? undefined
          : {
              ...catalog,
              models: catalog.models.map((model) => ({
                ...model,
                adapter: { claudeCode: { minVersion: "invalid" } },
              })),
            };
      const haiku = () =>
        resolveClaudeModelCatalog(input).models.find(
          (entry) => entry.model.slug === "claude-haiku-5-5",
        )?.model;
      assert.strictEqual(haiku()?.badge, "new");
      now.mockReturnValue(Date.parse("2026-10-14T00:00:00Z"));
      assert.strictEqual(haiku()?.badge, undefined);
      assert.strictEqual(haiku()?.slug, "claude-haiku-5-5");
    },
  );

  it("resolves capacity from selected options and fixed catalog windows without guessing custom models", () => {
    const source = manifest();
    const profile = source.providers!.claudeAgent!.profiles.synthetic!;
    const catalog = catalogFromManifest({
      ...source,
      providers: {
        claudeAgent: {
          ...source.providers!.claudeAgent!,
          profiles: {
            fixed: {
              capabilities: { optionDescriptors: [] },
              adapter: { claudeCode: { fixedContextWindowTokens: 64_000 } },
            },
            synthetic: {
              ...profile,
              adapter: { claudeCode: { contextWindowTokens: { large: 1_000_000, small: 32_000 } } },
            },
          },
          models: [
            ...source.providers!.claudeAgent!.models,
            {
              slug: "fixed",
              name: "Fixed",
              status: "current",
              profile: "fixed",
            },
          ],
        },
      },
    });
    const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "synthetic" };
    assert.equal(resolveClaudeCatalogContextWindowTokens(catalog, selection), 1_000_000);
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, {
        ...selection,
        options: [{ id: "contextWindow", value: "small" }],
      }),
      32_000,
    );
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "fixed" }),
      64_000,
    );
    assert.isUndefined(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "custom" }),
    );
  });

  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = catalogFromManifest(manifest());
    assert.deepStrictEqual(resolveClaudeModelsForVersion(catalog, "3.1.9"), []);
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.1.9"), [
      { slug: "claude-synthetic-next", name: "Claude Synthetic Next", minVersion: "3.2.0" },
    ]);
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.2.0"), []);
    assert.strictEqual(
      formatClaudeVersionUpgradeMessage(catalog, "3.1.9"),
      "Claude Code v3.1.9 is too old for Claude Synthetic Next. Upgrade to v3.2.0 or newer to access it.",
    );
  });

  it("resolves aliases and declarative adapter mappings", () => {
    const base = manifest();
    const input: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          models: [
            {
              slug: "claude-synthetic-collision",
              name: "Claude Synthetic Collision",
              aliases: ["claude-synthetic-next"],
              status: "current",
            },
            ...base.providers!.claudeAgent!.models,
          ],
        },
      },
    };
    const catalog = catalogFromManifest(input);
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "claude-synthetic-next");
    assert.strictEqual(
      resolveClaudeModelSlug(catalog, "claude-synthetic-next"),
      "claude-synthetic-next",
    );
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "extreme", "synthetic"), "high");
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "synthetic",
      }),
      "claude-synthetic-next[large]",
    );
  });

  it("appends custom models with their own descriptors and keeps bare slugs opaque", () => {
    const catalog = scopeClaudeModelCatalog(catalogFromManifest(manifest()), [
      "synthetic",
      {
        slug: "claude-custom-tuned",
        name: "Tuned",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "gentle", label: "Gentle", isDefault: true },
                { id: "brutal", label: "Brutal" },
              ],
            },
          ],
        },
      },
    ]);

    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "synthetic");
    assert.isUndefined(resolveClaudeCatalogEffort(catalog, "synthetic", "extreme"));
    assert.strictEqual(resolveClaudeCatalogEffort(catalog, "synthetic", "max"), "max");
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "max", "synthetic"), "max");

    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "brutal"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "bogus"),
      "gentle",
    );
    assert.strictEqual(
      normalizeClaudeCatalogEffort(catalog, "brutal", "claude-custom-tuned"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-custom-tuned",
        options: [{ id: "effort", value: "brutal" }],
      }),
      "claude-custom-tuned",
    );
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next", "claude-custom-tuned"],
    );
  });
});
