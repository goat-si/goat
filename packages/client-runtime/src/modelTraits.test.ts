import type { ProviderOptionDescriptor } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { isReasoningSliderDescriptor, reasoningSliderPosition } from "./modelTraits.ts";

const select = (
  id: string,
  options: ReadonlyArray<{ id: string; isDefault?: boolean }>,
): Extract<ProviderOptionDescriptor, { type: "select" }> => ({
  id,
  label: id,
  type: "select",
  options: options.map((option) => ({ ...option, label: option.id })),
});

describe("isReasoningSliderDescriptor", () => {
  it.each([
    [
      "Codex effort ladder",
      select("reasoningEffort", [{ id: "low" }, { id: "medium" }, { id: "ultra" }]),
      true,
    ],
    [
      "Claude effort with prompt-injected ultrathink",
      select("effort", [{ id: "low" }, { id: "max" }, { id: "ultracode" }, { id: "ultrathink" }]),
      true,
    ],
    [
      "Pi thinking levels",
      select("thinking", [{ id: "off" }, { id: "minimal" }, { id: "high" }]),
      true,
    ],
    ["Cursor thinking on/off", select("thinking", [{ id: "false" }, { id: "true" }]), false],
    ["OpenCode named variants", select("variant", [{ id: "low" }, { id: "high" }]), false],
    ["out-of-order levels", select("effort", [{ id: "high" }, { id: "low" }]), false],
    ["a single level", select("effort", [{ id: "high" }]), false],
    ["a non-reasoning select", select("contextWindow", [{ id: "low" }, { id: "high" }]), false],
  ])("%s -> %s", (_name, descriptor, expected) => {
    expect(isReasoningSliderDescriptor(descriptor)).toBe(expected);
  });
});

describe("reasoningSliderPosition", () => {
  const descriptor = select("effort", [
    { id: "low" },
    { id: "high", isDefault: true },
    { id: "max" },
  ]);

  it("places the current value and marks the provider default", () => {
    expect(reasoningSliderPosition(descriptor, "max")).toEqual({ index: 2, defaultIndex: 1 });
  });

  it("falls back to the default stop when nothing is chosen yet", () => {
    expect(reasoningSliderPosition(descriptor, undefined)).toEqual({ index: 1, defaultIndex: 1 });
  });

  it("gives up on a value the model does not offer, so the list picker can show it", () => {
    expect(reasoningSliderPosition(descriptor, "xhigh")).toBeNull();
  });

  it("reports no default stop when the provider names none", () => {
    expect(
      reasoningSliderPosition(select("effort", [{ id: "low" }, { id: "high" }]), "low"),
    ).toEqual({
      index: 0,
      defaultIndex: null,
    });
  });
});
