import { BotTaskRow, type ChannelListBotThreadsResult } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { botSnoozeFold, type BotSnoozeFoldPages } from "./taskSnooze.ts";

const at = "2026-11-10T00:00:00.000Z";
const decodeRow = Schema.decodeUnknownSync(BotTaskRow);
const row = (id: string) =>
  decodeRow({
    kind: "task",
    task: { taskId: id, title: id, status: "completed", updatedAt: at },
    view: { taskId: id, pinnedAt: null, doneAt: null, readThrough: null, snoozedUntil: at },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });

it("reopens an exhausted continuation on a changed snooze set without dropping loaded rows", async () => {
  const first = row("first");
  const loaded = row("loaded");
  const added = row("added");
  const result = (snoozedRevision: string, snoozed: ReadonlyArray<typeof BotTaskRow.Type>) => ({
    rows: [],
    mainMessageCount: 0,
    snoozed,
    snoozedRevision,
  });
  let pages: BotSnoozeFoldPages | undefined;
  const activeSnoozes = [{ taskId: loaded.task.taskId, until: at }];
  const read = vi
    .fn<(cursor: string) => Promise<ChannelListBotThreadsResult>>()
    .mockResolvedValueOnce(result("before", [loaded]))
    .mockResolvedValueOnce(result("after", [loaded, added]));
  const fold = (revision: string) =>
    botSnoozeFold({
      scope: "env:bot",
      first: { ...result(revision, [first]), snoozedNextCursor: "same-cursor" },
      loaded: true,
      home: { isPending: false, refresh: () => {} },
      activeSnoozes,
      pages,
      setPages: (update) => {
        pages = update(pages);
      },
      read,
    });

  await fold("before").continuation?.loadMore();
  expect(fold("before").continuation).toBeUndefined();
  expect(fold("after").rows).toEqual([first, loaded]);
  expect(fold("after").continuation).toBeDefined();
  await fold("after").continuation?.loadMore();
  expect(read.mock.calls).toEqual([["same-cursor"], ["same-cursor"]]);
  activeSnoozes.push({ taskId: added.task.taskId, until: at });
  expect(fold("after").continuation).toBeUndefined();
  expect(fold("after").rows).toEqual([first, loaded, added]);
});

it("caps the Snoozed fold at 500 rows even when the last page crosses the limit", async () => {
  const snoozed = Array.from({ length: 501 }, (_, index) => row(`task-${index + 1}`));
  const first = { rows: [], snoozed: snoozed.slice(0, 50), snoozedNextCursor: "50" };
  let pages: BotSnoozeFoldPages | undefined;
  const read = vi.fn(async (cursor: string): Promise<ChannelListBotThreadsResult> => {
    const start = Number(cursor);
    return {
      rows: [],
      mainMessageCount: 0,
      snoozed: snoozed.slice(start, start + 41),
      ...(start + 41 < snoozed.length ? { snoozedNextCursor: String(start + 41) } : {}),
    };
  });
  const fold = () =>
    botSnoozeFold({
      scope: "env:bot",
      first,
      loaded: true,
      home: { isPending: false, refresh: () => {} },
      pages,
      setPages: (update) => {
        pages = update(pages);
      },
      read,
    });

  for (let page = 0; page < 11; page++) await fold().continuation?.loadMore();
  expect(fold().rows).toEqual(snoozed.slice(0, 500));
  expect(pages?.rows).toHaveLength(500);
  expect(fold().continuation).toBeUndefined();
  expect(fold().limitReached).toBe(true);
});
