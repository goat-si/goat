import * as Result from "effect/Result";
import { expect, it } from "vite-plus/test";
import { decodeDiscussionsJson } from "./gitLabMergeRequestJson.ts";

it("retains file and image discussions without inventing line numbers", () => {
  const discussion = (id: string, position: Record<string, unknown>) => ({
    id,
    notes: [{ id: 1, body: "comment", created_at: "2026-07-01Z", position }],
  });
  const decoded = decodeDiscussionsJson(
    JSON.stringify([
      discussion("text", { position_type: "text", new_path: "src/a.ts", new_line: 12 }),
      discussion("file", { position_type: "file", new_path: "src/b.ts" }),
      discussion("image", { position_type: "image", old_path: "logo.png" }),
    ]),
  );
  expect(Result.isSuccess(decoded)).toBe(true);
  if (!Result.isSuccess(decoded)) return;
  expect(
    decoded.success.threads.map(({ id, path, line, side }) => ({ id, path, line, side })),
  ).toEqual([
    { id: "text", path: "src/a.ts", line: 12, side: "right" },
    { id: "file", path: "src/b.ts", line: null, side: "right" },
    { id: "image", path: "logo.png", line: null, side: "right" },
  ]);
});
