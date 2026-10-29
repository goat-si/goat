import { assert, describe, it } from "@effect/vitest";

import { macWithSwift, runSwiftChecks } from "./ComputerUseHelperSwift.testkit.ts";

describe("computer use helper live pictures (Swift)", () => {
  // quarantine: #1588 The native helper and its Swift toolchain are macOS-only.
  it.skipIf(!macWithSwift)(
    "reaches the window server from a process without AppKit instead of aborting on CGS_REQUIRE_INIT",
    () => {
      const result = runSwiftChecks(["WindowServer.swift"], "WindowServerInitTests.swift");
      assert.isTrue(result.ok, result.output);
    },
  );
});
