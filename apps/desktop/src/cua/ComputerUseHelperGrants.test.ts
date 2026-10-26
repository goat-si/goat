// @effect-diagnostics nodeBuiltinImport:off -- Compiles and runs the helper's Swift checks.
import { assert, describe, it } from "@effect/vitest";

import { macWithSwift, runSwiftChecks } from "./ComputerUseHelperSwift.testkit.ts";

describe("computer use helper grant reads (Swift)", () => {
  it.skipIf(!macWithSwift)(
    "reads a grant that is off again on a bounded window before reporting it missing (#1597)",
    () => {
      const result = runSwiftChecks(["PermissionSettle.swift"], "GrantSettleTests.swift");
      assert.isTrue(result.ok, result.output);
    },
  );
});
