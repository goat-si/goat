import type { BotRemoteWork, BotThreadRow, ChannelListBotThreadsResult } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyHistoryPress,
  botWorkHistoryView,
  EMPTY_WALK,
  writeThrough,
} from "./botWorkHistory.ts";

const at = "2026-11-10T00:00:00.000Z";
const task = (taskId: string, title = taskId) =>
  ({
    kind: "task",
    task: { taskId, title, status: "completed", updatedAt: at },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  }) as unknown as BotThreadRow;
const remote = (childWorkId: string, taskId: string, state: string) =>
  ({
    childWorkId,
    taskId,
    callerThreadId: "bot",
    host: "mini",
    state,
    lastActivityAt: at,
  }) as unknown as BotRemoteWork;
const list = (
  rows: BotThreadRow[],
  remoteWork: BotRemoteWork[] = [],
): ChannelListBotThreadsResult => ({
  rows,
  remoteWork,
  mainMessageCount: 0,
});
const page = (
  rows: BotThreadRow[],
  extra: Partial<NonNullable<ChannelListBotThreadsResult["history"]>> = {},
  remoteWork: BotRemoteWork[] = [],
) => ({
  cursor: undefined,
  result: { rows, remoteWork, mainMessageCount: 0, history: { nextCursor: "next", ...extra } },
});
const capabilities = { goatBotTaskThreadsPaged: true } as never;

describe("botWorkHistory", () => {
  it("never lets a page overwrite a task the walk already holds", () => {
    const first = applyHistoryPress(EMPTY_WALK, {
      supported: true,
      pages: [page([task("t1", "First")])],
    });
    const second = applyHistoryPress(first, {
      supported: true,
      pages: [page([task("t1", "Later copy")])],
    });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.task.task.title).toBe("First");
  });

  it("keeps a released launch only history lists when the current list writes the task through", () => {
    const walk = applyHistoryPress(EMPTY_WALK, {
      supported: true,
      pages: [
        page([task("t1")], {}, [
          remote("r-released", "t1", "released"),
          remote("r-old", "t1", "running"),
        ]),
      ],
    });
    const written = writeThrough(walk, list([task("t1")], [remote("r-now", "t1", "running")]));
    expect(written.entries[0]?.remoteWork.map((item) => item.childWorkId).sort()).toEqual([
      "r-now",
      "r-released",
    ]);
  });

  it("stops offering more at 500 older tasks and says work may be missing while a cursor remains", () => {
    const rows = Array.from({ length: 500 }, (_, index) => task(`t${index}`));
    const walk = applyHistoryPress(EMPTY_WALK, { supported: true, pages: [page(rows)] });
    const view = (current: ChannelListBotThreadsResult) =>
      botWorkHistoryView({ walk, current, capabilities, botId: null, loaded: true });
    expect(view(list([])).hasMore).toBe(false);
    expect(view(list([])).incomplete).toBe(true);
    // A held task back in the current list no longer counts as older, so reading can go on.
    expect(view(list([task("t0")])).hasMore).toBe(true);
    expect(view(list([task("t0")])).incomplete).toBe(false);
  });
});
