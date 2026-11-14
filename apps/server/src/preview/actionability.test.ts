import { expect, it } from "vite-plus/test";
import { actionabilityReason } from "./actionability.ts";

it("extracts only a known actionability reason from colored Playwright logs", () => {
  expect(actionabilityReason("timeout\n  \u001b[2m- element is not visible\u001b[22m\n")).toBe(
    "visible",
  );
  expect(actionabilityReason("selector contains element is not visible secret")).toBeUndefined();
  expect(actionabilityReason(" - element is not enabled\n - element is not stable")).toBe("stable");
});
