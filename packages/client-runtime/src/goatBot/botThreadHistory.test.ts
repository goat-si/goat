import { describe, expect, it } from "@effect/vitest";
import { BotId, BotRemoteWork, BotThreadRow, ChannelTaskId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { botThreadsHistoryInput, mergeBotThreadHistory } from "./botThreadHistory.ts";

const row = Schema.decodeUnknownSync(BotThreadRow);
const remoteWork = Schema.decodeUnknownSync(BotRemoteWork);
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
  const merge = (...args: Parameters<typeof mergeBotThreadHistory>) => {
    const result = mergeBotThreadHistory(...args);
    if (!result.supported) throw new Error("expected a history merge");
    return result;
  };
  const remote = (taskId: string, index: number) =>
    remoteWork({
      childWorkId: `${taskId}-remote-${index}`,
      taskId,
      callerThreadId: "bot",
      host: "box",
      state: "released",
      lastActivityAt: at,
      threadId: `remote-${index}`,
    });

  it("keeps each row once with the current list's copy, and its message count", () => {
    const merged = merge({ rows: [task("a", "current"), coding("a", "t1")], mainMessageCount: 3 }, [
      {
        rows: [task("a", "older copy"), coding("a", "t1"), task("b")],
        mainMessageCount: 0,
        remoteWork: [],
        history: { nextCursor: "v1.x" },
      },
      { rows: [task("b"), task("c")], mainMessageCount: 0, history: {} },
    ]);
    expect(
      merged.rows.map((item) => (item.kind === "task" ? item.task.title : item.threadId)),
    ).toEqual(["current", "t1", "b", "c"]);
    expect(merged.mainMessageCount).toBe(3);
  });

  it("keeps a truncation flag for a listed task whose released remote launches only history has", () => {
    const merged = merge({ rows: [task("a")], mainMessageCount: 0 }, [
      {
        rows: [],
        mainMessageCount: 0,
        remoteWork: Array.from({ length: 20 }, (_, index) => remote("a", index)),
        history: { launchesTruncated: [ChannelTaskId.make("a")] },
      },
    ]);
    expect([...merged.launchesTruncated]).toEqual(["a"]);
    expect(merged.remoteWork).toHaveLength(20);
  });

  it("keeps a truncation flag for a listed task whose launches bound after the current list was read", () => {
    const merged = merge({ rows: [task("a"), coding("a", "t0")], mainMessageCount: 0 }, [
      {
        rows: [
          task("a"),
          ...Array.from({ length: 20 }, (_, index) => coding("a", `t${index + 1}`)),
        ],
        mainMessageCount: 0,
        history: { launchesTruncated: [ChannelTaskId.make("a")] },
      },
    ]);
    expect([...merged.launchesTruncated]).toEqual(["a"]);
  });

  it("reports an answer without the history marker as unsupported", () => {
    const current = { rows: [task("a")], mainMessageCount: 0 };
    expect(mergeBotThreadHistory(current, [{ rows: [task("a")], mainMessageCount: 0 }])).toEqual({
      supported: false,
    });
    expect(
      mergeBotThreadHistory(current, [
        { rows: [], mainMessageCount: 0, history: { nextCursor: "v1.x" } },
        { rows: [task("b")], mainMessageCount: 0 },
      ]),
    ).toEqual({ supported: false });
  });

  it("goes on past an empty page that carries a cursor", () => {
    const merged = merge({ rows: [task("a")], mainMessageCount: 0 }, [
      { rows: [], mainMessageCount: 0, history: { nextCursor: "v1.x" } },
    ]);
    expect(merged.rows.map((item) => (item.kind === "task" ? item.task.taskId : ""))).toEqual([
      "a",
    ]);
    expect(merged.nextCursor).toBe("v1.x");
    expect(
      merge({ rows: [], mainMessageCount: 0 }, [{ rows: [], mainMessageCount: 0, history: {} }])
        .nextCursor,
    ).toBeUndefined();
  });

  it("says the walk is partial when any page left out a record it could not read", () => {
    const current = { rows: [task("a")], mainMessageCount: 0 };
    const first = { rows: [task("b")], mainMessageCount: 0, history: { nextCursor: "v1.x" } };
    expect(merge(current, [first, { rows: [], mainMessageCount: 0, history: {} }]).partial).toBe(
      false,
    );
    expect(
      merge(current, [
        { ...first, history: { nextCursor: "v1.x", partial: true } },
        { rows: [], mainMessageCount: 0, history: {} },
      ]).partial,
    ).toBe(true);
  });

  it("says the walk ended early when a page could not name its next task", () => {
    const current = { rows: [task("a")], mainMessageCount: 0 };
    const first = { rows: [task("b")], mainMessageCount: 0, history: { nextCursor: "v1.x" } };
    expect(
      merge(current, [first, { rows: [task("c")], mainMessageCount: 0, history: {} }]).endedEarly,
    ).toBe(false);
    expect(
      merge(current, [
        first,
        { rows: [task("c")], mainMessageCount: 0, history: { endedEarly: true } },
      ]).endedEarly,
    ).toBe(true);
  });
});
