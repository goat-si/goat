import {
  CodeView,
  DEFAULT_THEMES,
  parsePatchFiles,
  preloadHighlighter,
  type CodeViewItem,
} from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const keep = 1;
-const oldName = 2;
+const newName = 2;
+const added = oldName;
 const tail = 4;
@@ -20,3 +21,3 @@ function x() {
 ctx20 name
-del21 Name
+add22 names
 ctx22
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
-nil
+: nil
`;

it("finds deleted and added lines in order, including folded files", async () => {
  await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["text"] });
  const root = document.createElement("div");
  root.style.cssText = "width: 800px; height: 400px; overflow: auto;";
  document.body.append(root);
  let items: CodeViewItem<undefined>[] = parsePatchFiles(PATCH)[0]!.files.map(
    (fileDiff, index) => ({
      id: `file-${index}`,
      type: "diff",
      fileDiff,
      collapsed: index === 1,
    }),
  );
  const view = new CodeView<undefined>({
    diffStyle: "split",
    searchOptions: { scrollBehavior: "instant" },
    onRevealSearchMatch: (item) => {
      items = items.map((candidate) =>
        candidate.id === item.id ? { ...candidate, collapsed: false, version: 1 } : candidate,
      );
      view.setItems(items);
    },
  });
  using _view = {
    [Symbol.dispose]: () => {
      view.cleanUp();
      root.remove();
    },
  };
  view.setup(root);
  view.setItems(items);
  const matches = () =>
    (
      view as unknown as {
        searchState: {
          matches: Array<{
            itemId: string;
            side: string;
            lineNumber: number;
            startCharacter: number;
            endCharacter: number;
          }>;
        };
      }
    ).searchState.matches.map(
      ({ itemId, side, lineNumber, startCharacter, endCharacter }) =>
        `${itemId}:${side}:${lineNumber}:${startCharacter}-${endCharacter}`,
    );
  view.openSearch({ query: "oldName" });
  await vi.waitFor(() =>
    expect(matches()).toEqual(["file-0:deletions:2:6-13", "file-0:additions:3:14-21"]),
  );
  view.openSearch({ query: "nil" });
  await vi.waitFor(() =>
    expect(matches()).toEqual(["file-1:deletions:1:0-3", "file-1:additions:1:2-5"]),
  );
});
