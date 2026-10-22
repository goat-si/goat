import { describe, expect, it } from "vite-plus/test";
import { type ProviderOptionDescriptor } from "@goat/contracts";
import { findReasoningDescriptor, resolveEffortStepIndex } from "./TraitsPicker";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function serviceTierDescriptor(
  currentValue: "default" | "priority" | "ultrafast" | "flex",
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "ultrafast", label: "Ultrafast" },
      { id: "flex", label: "Flex" },
    ],
    currentValue,
  };
}

const EFFORT = selectDescriptor(
  "reasoningEffort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);

const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

describe("effort slider", () => {
  const steps = selectDescriptor(
    "effort",
    [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium", isDefault: true },
      { id: "high", label: "High" },
      { id: "ultrathink", label: "Ultrathink" },
    ],
    "",
  );

  it("drives the reasoning select even when context window comes first", () => {
    expect(findReasoningDescriptor([CONTEXT_WINDOW, EFFORT])).toBe(EFFORT);
  });

  it("hides the slider for models without a reasoning choice", () => {
    expect(findReasoningDescriptor([CONTEXT_WINDOW, serviceTierDescriptor("default")])).toBeNull();
    expect(
      findReasoningDescriptor([
        selectDescriptor("effort", [{ id: "high", label: "High" }], "high"),
      ]),
    ).toBeNull();
  });

  it("places the thumb on the selected step, then the provider default", () => {
    expect(resolveEffortStepIndex(steps, "ultrathink")).toBe(3);
    expect(resolveEffortStepIndex(steps, null)).toBe(1);
    expect(resolveEffortStepIndex(steps, "retired")).toBe(1);
    expect(
      resolveEffortStepIndex(
        selectDescriptor(
          "effort",
          [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          "",
        ),
        null,
      ),
    ).toBe(0);
  });
});
