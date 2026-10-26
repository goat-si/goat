import { assert, describe, it } from "@effect/vitest";

import { makeAppCatalog, type CatalogApp } from "./appCatalog.ts";

describe("computer use app catalog", () => {
  it("names exactly the requestable apps, sorted by name, and reads each icon once", async () => {
    const asked: Array<ReadonlyArray<string>> = [];
    const catalog = makeAppCatalog(async (apps: ReadonlyArray<CatalogApp>) => {
      asked.push(apps.map((app) => app.id));
      return new Map(
        apps
          .filter((app) => app.id !== "com.example.NoIcon")
          .map((app) => [app.id, "data:image/png;base64,AA=="]),
      );
    });
    const listed = [
      { bundle_id: "com.example.Zed", name: "Zed" },
      { bundle_id: "com.apple.finder", name: "Finder" },
      { bundle_id: "com.example.NoIcon", name: "no icon" },
      { bundle_id: "com.apple.Passwords", name: "Passwords" },
      { bundle_id: "si.goat.desktop", name: "GOAT" },
    ];
    const first = await catalog(listed, ["si.goat.desktop"]);
    assert.deepEqual(first, [
      { id: "com.apple.finder", name: "Finder", icon: "data:image/png;base64,AA==" },
      { id: "com.example.NoIcon", name: "no icon" },
      { id: "com.example.Zed", name: "Zed", icon: "data:image/png;base64,AA==" },
    ]);
    await catalog(listed, ["si.goat.desktop"]);
    assert.deepEqual(asked, [["com.apple.finder", "com.example.NoIcon", "com.example.Zed"]]);
  });

  it("still lists names when reading icons fails", async () => {
    const catalog = makeAppCatalog(async () => {
      throw new Error("osascript timed out");
    });
    assert.deepEqual(await catalog([{ bundle_id: "com.apple.finder", name: "Finder" }], []), [
      { id: "com.apple.finder", name: "Finder" },
    ]);
  });
});
