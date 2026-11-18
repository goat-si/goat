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

it("runs selected server files from the server project and keeps all other filters", async () => {
  const { changedVitestBatches } = await import("./split-tests.ts");
  expect(
    changedVitestBatches([
      "apps/server/src/http.test.ts",
      "apps/web/src/components/Example.browser.test.tsx",
      "apps/server/scripts/migrate-dev-db.test.ts",
      "packages/shared/src/path.test.ts",
    ]),
  ).toEqual([
    {
      cwd: "apps/server",
      files: ["src/http.test.ts", "scripts/migrate-dev-db.test.ts"],
    },
    {
      cwd: ".",
      files: [
        "apps/web/src/components/Example.browser.test.tsx",
        "packages/shared/src/path.test.ts",
      ],
    },
  ]);
  expect(changedVitestBatches([])).toEqual([]);
});
