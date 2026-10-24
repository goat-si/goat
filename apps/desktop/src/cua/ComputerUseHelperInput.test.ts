// @effect-diagnostics nodeBuiltinImport:off -- Compiles and runs the helper's Swift checks with the host toolchain.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";

const helperDir = NodePath.join(import.meta.dirname, "../../native/computer-use-helper");
const swiftc = () =>
  NodeChildProcess.spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" }).status === 0;
// The helper is macOS-only and its checks need the host's Swift toolchain.
const macWithSwift = HostProcess.Platform.defaultValue() === "darwin" && swiftc();

describe("computer use helper input reports (Swift)", () => {
  it("reads nothing of an input event but its type: no position, button, key or field", () => {
    const source = NodeFS.readFileSync(NodePath.join(helperDir, "HumanInput.swift"), "utf8");
    // Every CGEvent accessor that could reveal where or what a person clicked or typed.
    for (const accessor of [
      /\.location\b/,
      /unflippedLocation/,
      /getIntegerValueField/,
      /getDoubleValueField/,
      /keyboardGetUnicodeString/,
      /\.flags\b/,
      /CGEventGet/,
    ])
      assert.notMatch(source, accessor);
  });

  it.skipIf(!macWithSwift)(
    "reports each mouse button press with its own time, so an agent's cannot hide a person's",
    () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-helper-input-"));
      try {
        const binary = NodePath.join(dir, "checks");
        const build = NodeChildProcess.spawnSync(
          "xcrun",
          [
            "swiftc",
            "-parse-as-library",
            "-o",
            binary,
            NodePath.join(helperDir, "HumanInput.swift"),
            NodePath.join(helperDir, "tests/HumanInputTests.swift"),
          ],
          { encoding: "utf8" },
        );
        assert.equal(build.status, 0, build.stderr);
        const result = NodeChildProcess.spawnSync(binary, { encoding: "utf8" });
        assert.equal(result.status, 0, result.stdout + result.stderr);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
