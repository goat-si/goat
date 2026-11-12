import { describe, expect, it } from "vite-plus/test";
import { applyProviderOptionSelection, resolveProviderOptionDescriptors } from "./providerOptions";

const capabilities = {
  optionDescriptors: [
    {
      id: "thinking",
      label: "Thinking",
      type: "select" as const,
      currentValue: "high",
      options: [{ id: "high", label: "High" }],
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select" as const,
      currentValue: "default",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
        { id: "ultrafast", label: "Ultrafast" },
      ],
    },
  ],
};

describe("Pi model options on mobile", () => {
  it("offers advertised tiers and keeps thinking when a tier is selected", () => {
    const descriptors = resolveProviderOptionDescriptors({ capabilities, selections: [] });
    expect(descriptors.find((descriptor) => descriptor.id === "serviceTier")).toMatchObject({
      options: [{ id: "default" }, { id: "priority" }, { id: "ultrafast" }],
    });
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "priority" }),
    ).toContainEqual({ id: "serviceTier", value: "priority" });
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "priority" }),
    ).toContainEqual({ id: "thinking", value: "high" });
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "unknown" }),
    ).toBeNull();
  });
});
