import { expect, it, vi } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import { act, render } from "../../../test/render";
import { getRenderablePatch } from "../../lib/diffRendering";
import { StyledDiffCodeView } from "./StyledDiffCodeView";

/** The text Chromium's accessibility tree gives a screen reader, in reading order. */
async function screenReaderText() {
  const session = cdp();
  const { frameTree } = await session.send("Page.getFrameTree");
  const frame = [frameTree, ...(frameTree.childFrames ?? [])].find(
    (tree) => tree.frame.url === location.href,
  );
  const { nodes } = await session.send("Accessibility.getFullAXTree", {
    frameId: frame!.frame.id,
  });
  return nodes
    .filter((node) => !node.ignored && node.role?.value === "StaticText")
    .map((node) => String(node.name?.value ?? ""))
    .join("");
}

it("tells a screen reader which lines were removed and which were added", async () => {
  const parsed = getRenderablePatch(
    [
      "diff --git a/limits.ts b/limits.ts",
      "--- a/limits.ts",
      "+++ b/limits.ts",
      "@@ -1,2 +1,2 @@",
      " export const name = 1;",
      "-const limit = 10;",
      "+const limit = 20;",
      "",
    ].join("\n"),
  );
  if (parsed?.kind !== "files") throw new Error("Expected file diffs");
  const ready = Promise.withResolvers<WorkerPoolManager>();
  const initialize = WorkerPoolManager.prototype.initialize;
  using _initialize = vi
    .spyOn(WorkerPoolManager.prototype, "initialize")
    .mockImplementation(function (this: WorkerPoolManager, ...args) {
      const pending = initialize.apply(this, args);
      void pending.then(() => ready.resolve(this), ready.reject);
      return pending;
    });
  await using _screen = await render(
    <StyledDiffCodeView
      className="h-[600px] w-[800px]"
      items={parsed.files.map((fileDiff, index) => ({
        type: "diff",
        id: String(index),
        fileDiff,
        version: 1,
      }))}
      options={{ theme: "pierre-dark", diffStyle: "unified" }}
    />,
    // This viewer fixture does not navigate or read router state.
    { router: false },
  );
  await act(async () => {
    const pool = await ready.promise;
    await Promise.all(parsed.files.map((file) => pool.primeDiffHighlightCache(file)));
  });
  await vi.waitFor(async () => {
    const text = await screenReaderText();
    expect(text).toContain("export const name = 1;Removedconst limit = 10;Addedconst limit = 20;");
  });
});
