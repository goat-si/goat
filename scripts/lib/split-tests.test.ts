import { describe, expect, it } from "vite-plus/test";
import { splitTests } from "./split-tests.ts";

describe("test runner selection", () => {
  it("routes CI node:test files away from Vitest on both path separators", () => {
    expect(
      splitTests([
        "apps/server/src/ws.test.ts",
        ".github/scripts/a.test.cjs",
        ".github\\scripts\\b.test.cjs",
        "scripts/a.test.ts",
      ]),
    ).toEqual({
      vitestTests: ["apps/server/src/ws.test.ts", "scripts/a.test.ts"],
      nodeTests: [".github/scripts/a.test.cjs", ".github\\scripts\\b.test.cjs"],
    });
  });
});
