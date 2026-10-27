import { assert, describe, it } from "@effect/vitest";

import { macWithSwift, runSwiftChecks } from "./ComputerUseHelperSwift.testkit.ts";

describe("computer use helper's privacy and capture decisions (Swift)", () => {
  it.skipIf(!macWithSwift)(
    "keeps windows out of frames when focus cannot be read yet pauses agents only for a focused secure field, names Screen Recording refusals, and skips off-screen targets",
    () => {
      const result = runSwiftChecks(["HelperSafety.swift"], "HelperSafetyTests.swift");
      assert.isTrue(result.ok, result.output);
    },
  );
});
