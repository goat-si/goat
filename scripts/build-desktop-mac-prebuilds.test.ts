// @effect-diagnostics nodeBuiltinImport:off - Node's glob matcher is the one electron-builder's file exclusions use.
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { resolveMacFileExclusions } from "./desktop-artifact-file-exclusions.ts";

it("drops the other architecture's Darwin prebuilds from single-architecture Mac builds", () => {
  const excludes = (arch: "arm64" | "x64" | "universal", file: string) =>
    resolveMacFileExclusions(arch).some((glob) => NodePath.matchesGlob(file, glob.slice(1)));
  const x64 = [
    "node_modules/node-pty/prebuilds/darwin-x64/pty.node",
    "node_modules/objc-js/prebuilds/darwin-x64/node.napi.node",
  ];
  const arm64 = [
    "node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
    "node_modules/objc-js/prebuilds/darwin-arm64/node.napi.armv8.node",
  ];

  for (const file of x64) {
    assert.isTrue(excludes("arm64", file), file);
    assert.isFalse(excludes("x64", file), file);
    assert.isFalse(excludes("universal", file), file);
  }
  for (const file of arm64) {
    assert.isTrue(excludes("x64", file), file);
    assert.isFalse(excludes("arm64", file), file);
    assert.isFalse(excludes("universal", file), file);
  }
});
