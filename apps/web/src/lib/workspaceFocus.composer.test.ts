import { expect, it } from "vite-plus/test";
import { workspaceAreaProps } from "./workspaceFocus";

it("keeps an unlabeled composer in the focus cycle without adding a landmark", () => {
  expect(workspaceAreaProps("composer", 2, "")).toEqual({
    "data-workspace-area": "composer",
    "data-workspace-order": 2,
    tabIndex: -1,
  });
});
