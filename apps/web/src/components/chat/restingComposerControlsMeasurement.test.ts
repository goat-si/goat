import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";

function measurePicker(input: {
  clientWidth: number;
  flexGrow: string;
  maxWidth?: string;
  expandedFooter?: boolean;
}) {
  const label = { clientWidth: input.clientWidth, scrollWidth: 160 };
  const picker = {
    getBoundingClientRect: () => ({ width: 52 }),
    querySelector: () => label,
  };
  const spacer = { getBoundingClientRect: () => ({ width: 300 }) };
  const controls = {
    querySelector: (selector: string) => {
      if (selector === "[data-chat-provider-model-picker]") return picker;
      if (selector === "[data-resting-controls-overflow]") {
        return { getBoundingClientRect: () => ({ width: 24 }) };
      }
      if (selector === "[data-resting-controls-spacer]" && input.expandedFooter) return spacer;
      return null;
    },
    querySelectorAll: (selector: string) => {
      if (selector === "[data-resting-fixed-control]") {
        return input.expandedFooter ? [{ getBoundingClientRect: () => ({ width: 28 }) }] : [];
      }
      return [
        {
          dataset: {},
          querySelectorAll: () => [],
          getBoundingClientRect: () => ({ width: 140 }),
        },
      ];
    },
  };
  vi.stubGlobal("getComputedStyle", (element: unknown) => {
    if (element === label) return { flexGrow: input.flexGrow };
    if (element === picker) return { minWidth: "52px", maxWidth: input.maxWidth ?? "none" };
    if (element === spacer) return { minWidth: "8px" };
    return { columnGap: "4px" };
  });
  return measureRestingComposerControls(controls as unknown as HTMLElement)!;
}

afterEach(() => vi.unstubAllGlobals());

describe("GOAT expanded footer measurement", () => {
  it("reserves the expanded footer's context meter and spacer minimum, not the grown spacer", () => {
    const measurement = measurePicker({ clientWidth: 0, flexGrow: "0", expandedFooter: true });

    // picker 52 + meter (28 + 4 gap) + spacer minimum (8 + 4 gap)
    expect(measurement.naturalFixedWidth).toBe(96);
    expect(measurement.minimumFixedWidth).toBe(96);
  });
});
