import { assert, describe, it } from "@effect/vitest";

import { macWithSwift, runSwiftChecks } from "./ComputerUseHelperSwift.testkit.ts";

describe("computer use helper's view of GOAT itself (Swift)", () => {
  it.skipIf(!macWithSwift)(
    "refuses a parent that can run as Node, and treats GOAT's own windows as never capturable",
    () => {
      const result = runSwiftChecks(["HostIdentity.swift"], "HostIdentityTests.swift");
      assert.isTrue(result.ok, result.output);
    },
  );
});
