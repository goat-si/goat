import { assert, describe, it } from "@effect/vitest";

import { unsupportedNodeMessage } from "./node-runtime.ts";

const check = (version: string, packageManager?: string) =>
  unsupportedNodeMessage({
    version,
    pinned: "26.12.1",
    execPath: "/usr/bin/node",
    command: "vp test run",
    packageManager,
  });

describe("unsupportedNodeMessage", () => {
  it("accepts the pinned release and later releases of its major", () => {
    for (const version of ["26.12.1", "26.12.2", "26.13.0"]) {
      assert.isUndefined(check(version, "pnpm@12.14.0"), version);
    }
  });

  it("refuses another major or an older release, naming the pin and how to switch (#1647)", () => {
    for (const version of ["22.22.2", "24.22.1", "26.8.2", "26.12.0", "27.0.0"]) {
      const message = check(version, "pnpm@12.14.0");
      assert.isDefined(message, version);
      assert.include(message, `/usr/bin/node is Node.js ${version}`);
      assert.include(message, "Node.js 26.12.1 (engines.node in the root package.json)");
      assert.include(
        message,
        "vp env exec --node 26.12.1 --package-manager pnpm@12.14.0 -- vp test run",
      );
      assert.include(message, "vp env on node");
    }
  });

  it("strips build metadata from packageManager and omits the flag when absent (#3711)", () => {
    const withHash = check("24.17.0", "pnpm@12.14.0+sha512-abc");
    assert.isDefined(withHash);
    assert.include(
      withHash,
      "vp env exec --node 26.12.1 --package-manager pnpm@12.14.0 -- vp test run",
    );

    const withoutPm = check("24.17.0");
    assert.isDefined(withoutPm);
    assert.include(withoutPm, "vp env exec --node 26.12.1 -- vp test run");
    assert.notInclude(withoutPm, "--package-manager");
  });
});
