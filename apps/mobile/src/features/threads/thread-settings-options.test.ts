import { getPromptControlledTraits, getTraitSelectChange } from "@goat/client-runtime/model-traits";
import { ProviderInstanceId, type ProviderOptionDescriptor } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderOptionSelection,
  resolveProviderOptionDescriptors,
  withImplicitFastModeSelection,
} from "../../lib/providerOptions";
import { selectableChoices } from "./thread-settings-options";

const effortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
    { id: "ultracode", label: "Ultracode" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};

describe("fast mode switch", () => {
  // regression: #29729 Cursor reports Fast on by default, but its picker shows an unset fastMode as off
  it("shows an unset fast mode as off, saves it as off and turns it on when toggled", () => {
    const capabilities = {
      optionDescriptors: [
        { id: "fastMode", label: "Fast", type: "boolean", currentValue: true } as const,
      ],
    };
    const selection = { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2.5" };
    const descriptors = resolveProviderOptionDescriptors({ capabilities, selections: undefined });
    const shown = descriptors.find((descriptor) => descriptor.id === "fastMode")?.currentValue;

    expect({
      shown,
      saved: withImplicitFastModeSelection(selection, [
        { instanceId: selection.instanceId, models: [{ slug: selection.model, capabilities }] },
      ]).options,
      afterToggle: applyProviderOptionSelection(descriptors, { id: "fastMode", value: !shown }),
    }).toEqual({
      shown: false,
      saved: [{ id: "fastMode", value: false }],
      afterToggle: [{ id: "fastMode", value: true }],
    });
  });
});

describe("selectableChoices", () => {
  // regression: #21406 bring model controls in line with web
  it("leaves out prompt-injected choices and keeps workflow choices in declared order", () => {
    expect(selectableChoices(effortDescriptor).map((choice) => choice.id)).toEqual([
      "low",
      "medium",
      "high",
      "ultracode",
    ]);
  });
});

describe("prompt-controlled reasoning", () => {
  it("removes the prefix when choosing a regular effort and saves Ultracode as an option", () => {
    const descriptors = [effortDescriptor];
    const prompt = "Ultrathink:\nsolve it";
    expect(
      getTraitSelectChange(
        { ...getPromptControlledTraits(descriptors, prompt), descriptors },
        effortDescriptor,
        prompt,
        "ultracode",
      ),
    ).toEqual({ prompt: "solve it", modelOptions: [{ id: "effort", value: "ultracode" }] });
  });

  it("keeps body-controlled Ultrathink locked", () => {
    const descriptors = [effortDescriptor];
    const prompt = "please ultrathink about this";
    const selected = { ...getPromptControlledTraits(descriptors, prompt), descriptors };
    expect(selected.ultrathinkInBodyText).toBe(true);
    expect(getTraitSelectChange(selected, effortDescriptor, prompt, "low")).toBeNull();
  });
});
