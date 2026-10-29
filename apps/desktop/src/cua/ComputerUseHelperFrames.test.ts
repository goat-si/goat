// @effect-diagnostics nodeBuiltinImport:off -- Reads the helper's entry source.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { helperDir, macWithSwift, runSwiftChecks } from "./ComputerUseHelperSwift.testkit.ts";

const declaration =
  /^(?:import|func|let|var|struct|enum|class|final|private|fileprivate|extension|protocol|typealias|@|#)\b|^[@#}/)\]]|^$/u;

describe("computer use helper live pictures (Swift)", () => {
  // quarantine: #1588 The native helper and its Swift toolchain are macOS-only.
  it.skipIf(!macWithSwift)(
    "reaches the window server from a process without AppKit instead of aborting on CGS_REQUIRE_INIT",
    () => {
      const result = runSwiftChecks(["WindowServer.swift"], "WindowServerInitTests.swift");
      assert.isTrue(result.ok, result.output);
    },
  );

  // main.swift's top-level code cannot be linked into a check program, and the built helper
  // refuses an untrusted parent; so the entry the check above runs must be all main.swift does.
  it("starts the helper only through WindowServer.startHelper", () => {
    const source = NodeFS.readFileSync(NodePath.join(helperDir, "main.swift"), "utf8");
    const statements = source
      .split("\n")
      .filter((line) => !/^\s/u.test(line) && !declaration.test(line));
    assert.deepEqual(statements, ["WindowServer.startHelper("]);
  });
});
