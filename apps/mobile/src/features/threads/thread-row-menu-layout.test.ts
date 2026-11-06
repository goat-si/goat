import { describe, expect, it } from "vite-plus/test";
import type { MenuAction } from "@react-native-menu/menu";
import { layoutThreadRowMenu } from "./thread-row-menu-layout";

describe("thread row menu", () => {
  it("keeps all actions reachable and limits the full iOS submenu", () => {
    const actions: MenuAction[] = [
      "new-thread-on-branch",
      "copy-thread",
      "copy-thread-id",
      "settle",
      "snooze",
      "arrange",
      "move-up",
      "move-down",
      "pin",
      "rename",
      "regenerate-title",
      "mark-unread",
      "turn-into-project",
      "auto-settle",
      "archive",
      "delete",
    ].map((id) => ({ id, title: id }));
    const nested = layoutThreadRowMenu(actions, true);
    const more = nested.find((action) => action.id === "more");
    const arrange = more?.subactions?.find((action) => action.id === "arrange-menu");
    const leaves = (items: readonly MenuAction[]): string[] =>
      items.flatMap((item) =>
        item.subactions ? leaves(item.subactions) : item.id ? [item.id] : [],
      );
    expect(more?.subactions?.length).toBeLessThanOrEqual(8);
    expect(arrange?.subactions?.map((item) => item.id)).toEqual([
      "arrange",
      "move-up",
      "move-down",
    ]);
    expect(nested.some((item) => item.id === "pin")).toBe(true);
    expect(leaves(nested).toSorted()).toEqual(leaves(actions).toSorted());
    expect(layoutThreadRowMenu(actions, false)).toEqual(actions);
  });
});
