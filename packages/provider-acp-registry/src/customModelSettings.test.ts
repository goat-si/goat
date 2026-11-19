import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AcpRegistrySettings } from "./settings.ts";

const decodeSettings = Schema.decodeUnknownSync(AcpRegistrySettings);

it("accepts legacy named custom models and rejects malformed structured details", () => {
  const legacy = decodeSettings({
    agentId: "example",
    customModels: [{ slug: "x", name: "Friendly" }],
  });
  expect(legacy.customModels).toEqual([{ slug: "x", name: "Friendly" }]);
  expect(() =>
    decodeSettings({
      agentId: "example",
      customModels: ["x"],
      customModelDetails: [{ slug: "x", name: 42 }],
    }),
  ).toThrow();
  expect(() =>
    decodeSettings({
      agentId: "example",
      customModels: ["x"],
      customModelDetails: [{ slug: "missing" }],
    }),
  ).toThrow();
});

it("enriches model names from rollback-safe structured details", async () => {
  const { ProviderInstanceId } = await import("@goat/contracts");
  const { buildCheckedAcpRegistrySnapshot } = await import("./server/driver.ts");
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };
  const settings = decodeSettings({
    agentId: "example",
    customModels: ["x"],
    customModelDetails: [{ slug: "x", name: "Friendly", capabilities }],
  });
  const provider = buildCheckedAcpRegistrySnapshot({
    instanceId: ProviderInstanceId.make("acp-example"),
    displayName: undefined,
    accentColor: undefined,
    continuationKey: "acp:example",
    settings,
    checkedAt: "2026-01-01T00:00:00.000Z",
    inspection: { status: "ready", agentId: "example", version: "1.0", distribution: "npx" },
  });
  expect(provider.models.find((model) => model.slug === "x")?.name).toBe("Friendly");
  expect(provider.models.find((model) => model.slug === "x")?.capabilities).toEqual(capabilities);
  expect(provider.supportsStructuredCustomModels).toBe(true);
});
