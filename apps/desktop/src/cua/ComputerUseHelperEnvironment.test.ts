import { assert, describe, it } from "@effect/vitest";

import { macWithSwift, runSwiftChecks } from "./ComputerUseHelperSwift.testkit.ts";

describe("what the computer use helper's driver inherits (Swift)", () => {
  it.skipIf(!macWithSwift)(
    "forces the driver's screencapture fallback off and keeps privacy switches (#1688)",
    () => {
      const result = runSwiftChecks(["DriverEnvironment.swift"], "DriverEnvironmentTests.swift");
      assert.isTrue(result.ok, result.output);
    },
  );
});
