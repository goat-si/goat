import { assert, describe, it } from "@effect/vitest";

import { macWithSwift, runSwiftChecks } from "./ComputerUseHelperSwift.testkit.ts";

describe("what the computer use helper's driver inherits (Swift)", () => {
  it.skipIf(!macWithSwift)(
    "runs the driver with a fixed system search path that has no screencapture (#1588)",
    () => {
      const result = runSwiftChecks(["DriverEnvironment.swift"], "DriverEnvironmentTests.swift");
      assert.isTrue(result.ok, result.output);
    },
  );
});
