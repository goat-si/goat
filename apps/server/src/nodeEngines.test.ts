import { NODE_SQLITE_RUNTIME_RANGE } from "@goat/shared/nodeSqliteClient";
import { satisfiesSemverRange } from "@goat/shared/semver";
import { describe, expect, it } from "vite-plus/test";

import serverPackage from "../package.json" with { type: "json" };

describe("server engines.node", () => {
  it("admits only runtimes whose node:sqlite reads TEXT past a NUL character (#1015)", () => {
    const range = serverPackage.engines.node;
    expect(range).toBe(NODE_SQLITE_RUNTIME_RANGE);
    // 24.22.0 is the Node inside Electron 44, which runs the desktop app's server.
    for (const version of ["24.16.0", "24.22.0", "26.1.0", "26.12.1"]) {
      expect(satisfiesSemverRange(version, range), version).toBe(true);
    }
    for (const version of ["22.22.2", "23.11.0", "24.15.0", "25.9.0", "26.0.0"]) {
      expect(satisfiesSemverRange(version, range), version).toBe(false);
    }
  });
});
