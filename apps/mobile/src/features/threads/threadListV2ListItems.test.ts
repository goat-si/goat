import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadShellFixture } from "../../test-fixtures";
import { buildThreadListV2ListItems } from "./threadListV2ListItems";
import type { ThreadListV2Item } from "./threadListV2Types";

describe("thread list item dividers", () => {
  it("shows a divider before another row but not before a section marker or the end", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const row = (id: string): ThreadListV2Item => ({
      thread: makeThreadShellFixture({ environmentId, id: ThreadId.make(id), title: id }),
      variant: "card",
      snoozed: false,
      pinned: false,
      wokeAt: null,
      isLast: false,
    });
    const items = buildThreadListV2ListItems({
      items: [row("first"), row("before-marker"), row("last")],
      pendingTasks: [],
      launchMarkers: [
        { afterIndex: 1, entry: { kind: "launch-more", parentKey: "parent", depth: 0, hidden: 2 } },
      ],
    });
    const dividers = items.flatMap((item) =>
      item.type === "v2-thread" ? [[item.item.thread.id, item.showTrailingDivider]] : [],
    );
    expect(dividers).toEqual([
      ["first", true],
      ["before-marker", false],
      ["last", false],
    ]);
  });
});
