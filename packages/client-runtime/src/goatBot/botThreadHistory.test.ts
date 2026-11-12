import { describe, expect, it } from "@effect/vitest";
import { BotId, BotThreadRow, ChannelTaskId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { botThreadsHistoryInput, mergeBotThreadHistory } from "./botThreadHistory.ts";

const row = Schema.decodeUnknownSync(BotThreadRow);
const at = "2026-11-04T00:00:00.000Z";
const task = (id: string, title = id) =>
  row({
    kind: "task",
    task: { taskId: id, title, status: "running", updatedAt: at },
    view: { taskId: id, doneAt: null, pinnedAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
const coding = (taskId: string, threadId: string) =>
  row({
    kind: "coding",
    taskId,
    environmentId: "env",
    threadId,
    state: "bound",
    lastActivityAt: at,
  });

describe("botThreadsHistoryInput", () => {
  it("asks only a server that walks history, and sends the cursor it was given", () => {
    expect(
      botThreadsHistoryInput({ repositoryIdentity: false, goatBotTaskThreads: true }, null),
    ).toBeNull();
    expect(
      botThreadsHistoryInput({ repositoryIdentity: false, goatBotTaskThreadsPaged: true }, null),
    ).toEqual({
      history: {},
    });
    expect(
      botThreadsHistoryInput(
        { repositoryIdentity: false, goatBotTaskThreadsPaged: true },
        BotId.make("helper"),
        "v1.next",
      ),
    ).toEqual({ botId: "helper", history: { cursor: "v1.next" } });
  });
});

describe("mergeBotThreadHistory", () => {
  it("keeps each row once with the current list's copy, and its message count", () => {
    const merged = mergeBotThreadHistory(
      { rows: [task("a", "current"), coding("a", "t1")], mainMessageCount: 3 },
      [
        {
          rows: [task("a", "older copy"), coding("a", "t1"), task("b")],
          mainMessageCount: 9,
          remoteWork: [],
          history: { nextCursor: "v1.x" },
        },
        { rows: [task("b"), task("c")], mainMessageCount: 9, history: {} },
      ],
    );
    expect(
      merged.rows.map((item) => (item.kind === "task" ? item.task.title : item.threadId)),
    ).toEqual(["current", "t1", "b", "c"]);
    expect(merged.mainMessageCount).toBe(3);
  });

  it("drops a truncation flag for a task whose launches the current list carries in full", () => {
    const merged = mergeBotThreadHistory({ rows: [task("a")], mainMessageCount: 0 }, [
      {
        rows: [task("a"), task("b")],
        mainMessageCount: 0,
        history: { launchesTruncated: [ChannelTaskId.make("a"), ChannelTaskId.make("b")] },
      },
    ]);
    expect([...merged.launchesTruncated]).toEqual(["b"]);
  });

  it("says the walk ended early when a page could not name its next task", () => {
    const current = { rows: [task("a")], mainMessageCount: 0 };
    const first = { rows: [task("b")], mainMessageCount: 0, history: { nextCursor: "v1.x" } };
    expect(
      mergeBotThreadHistory(current, [
        first,
        { rows: [task("c")], mainMessageCount: 0, history: {} },
      ]).endedEarly,
    ).toBe(false);
    expect(
      mergeBotThreadHistory(current, [
        first,
        { rows: [task("c")], mainMessageCount: 0, history: { endedEarly: true } },
      ]).endedEarly,
    ).toBe(true);
  });
});
