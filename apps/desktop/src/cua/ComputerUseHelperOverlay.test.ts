import { assert, describe, it } from "@effect/vitest";

import { macWithSwift, runSwiftChecks } from "./ComputerUseHelperSwift.testkit.ts";

describe("computer use helper's overlay order (Swift)", () => {
  it.skipIf(!macWithSwift)(
    "raises the overlay to the front only for the frontmost app's front window, so covering windows hide it",
    () => {
      const result = runSwiftChecks(["OverlayOrder.swift"], "OverlayOrderTests.swift");
      assert.isTrue(result.ok, result.output);
    },
  );
});
