// @effect-diagnostics nodeBuiltinImport:off -- Compiles and runs the helper's Swift checks.
import { assert, describe, it } from "@effect/vitest";

import { macWithSwift, runSwiftChecks } from "./ComputerUseHelperSwift.testkit.ts";

describe("computer use helper driver environment (Swift)", () => {
  // quarantine: #1588 The native helper and its Swift toolchain are macOS-only.
  it.skipIf(!macWithSwift)("forces screencapture off and filters inherited secrets (#1588)", () => {
    const result = runSwiftChecks(["DriverEnvironment.swift"], "DriverEnvironmentTests.swift");
    assert.isTrue(result.ok, result.output);
  });
});
