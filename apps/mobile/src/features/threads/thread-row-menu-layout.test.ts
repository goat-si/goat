import { describe, expect, it } from "vite-plus/test";
import { layoutThreadRowMenu } from "./thread-row-menu-layout";

describe("thread row menu", () => {
  it("keeps every action accessible while shortening the iOS menu", () => {
    const actions = ["copy", "settle", "pin", "rename", "archive", "delete", "goat-action"].map(
      (id) => ({ id, title: id }),
    );
    const nested = layoutThreadRowMenu(actions, true);
    expect(nested.length).toBeLessThan(actions.length);
    expect(
      nested.flatMap((action) => action.subactions ?? [action]).map((action) => action.id),
    ).toEqual(actions.map((action) => action.id));
    expect(layoutThreadRowMenu(actions, false)).toEqual(actions);
  });
});
