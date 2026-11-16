import * as Result from "effect/Result";
import { expect, it } from "vite-plus/test";
import { decodeIterationChangesJson } from "./azureDevOpsPullRequestJson.ts";

it("keeps deleted paths from Azure's source fields without a viewed revision", () => {
  const result = decodeIterationChangesJson(
    JSON.stringify({
      changeEntries: [
        { changeType: "delete", originalPath: "/GONE.md", item: { path: null, objectId: "2222" } },
        { changeType: "delete", sourceServerItem: "/src/gone.ts", item: { objectId: null } },
        { changeType: "delete", item: { originalObjectId: "3333" } },
        { changeType: "edit", originalPath: "/LOST.md", item: { objectId: "4444" } },
        {
          changeType: "rename",
          originalPath: "/old.md",
          item: { path: "/new.md", objectId: "5555" },
        },
      ],
    }),
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("decode failed");
  expect(
    result.success.changes.map(({ path, oldPath, changeKind, objectId }) => [
      path,
      oldPath,
      changeKind,
      objectId,
    ]),
  ).toEqual([
    ["GONE.md", "GONE.md", "deleted", null],
    ["src/gone.ts", "src/gone.ts", "deleted", null],
    ["new.md", "old.md", "rename-pure", "5555"],
  ]);
});
