// @effect-diagnostics nodeBuiltinImport:off -- Reads the helper's Swift source for the privacy check.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { helperDir, macWithSwift, runSwiftChecks } from "./ComputerUseHelperSwift.testkit.ts";

describe("computer use helper input reports (Swift)", () => {
  it("reads nothing of an input event but its type and driver eventSourceUserData tag: no position, button, key or other field", () => {
    const source = NodeFS.readFileSync(NodePath.join(helperDir, "HumanInput.swift"), "utf8");
    assert.match(source, /event\.getIntegerValueField\(\.eventSourceUserData\)/);
    const withoutAllowedUserDataRead = source.replaceAll(
      "event.getIntegerValueField(.eventSourceUserData)",
      "",
    );
    // Every CGEvent accessor that could reveal where or what a person clicked or typed.
    for (const accessor of [
      /\.location\b/,
      /unflippedLocation/,
      /getDoubleValueField/,
      /keyboardGetUnicodeString/,
      /\.flags\b/,
      /CGEventGet/,
    ])
      assert.notMatch(source, accessor);
    assert.notMatch(withoutAllowedUserDataRead, /getIntegerValueField/);
  });

  it.skipIf(!macWithSwift)(
    "reports each mouse button press with its own time, so an agent's cannot hide a person's",
    () => {
      const result = runSwiftChecks(["HumanInput.swift"], "HumanInputTests.swift");
      assert.isTrue(result.ok, result.output);
    },
  );
});
