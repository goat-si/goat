import { describe, expect, it } from "@effect/vitest";
import { BotId, BotRemoteWork, BotThreadRow, ChannelTaskId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import {
  BOT_THREAD_HISTORY_REQUESTS_PER_PRESS,
  botThreadsHistoryInput,
  mergeBotThreadHistory,
  readBotThreadHistory,
} from "./botThreadHistory.ts";

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

describe("readBotThreadHistory", () => {
  const page = (rows: ReadonlyArray<ReturnType<typeof task>>, nextCursor?: string) => ({
    rows,
    mainMessageCount: 0,
    history: nextCursor === undefined ? {} : { nextCursor },
  });
  const reader = (
    answers: ReadonlyArray<ReturnType<typeof page> | { rows: []; mainMessageCount: 0 }>,
  ) => {
    const asked: Array<string | undefined> = [];
    return {
      asked,
      read: async (cursor: string | undefined) => {
        asked.push(cursor);
        const answer = answers[asked.length - 1];
        if (answer === undefined) throw new Error("read past the fixture");
        return answer;
      },
    };
  };

  it("keeps reading past empty pages while a cursor comes back, and stops when none does", async () => {
    const pages = reader([page([], "v1.a"), page([], "v1.b"), page([task("old")])]);
    const result = await readBotThreadHistory({
      read: pages.read,
      from: undefined,
      listed: new Set(),
      wanted: 10,
    });
    expect(pages.asked).toEqual([undefined, "v1.a", "v1.b"]);
    expect(result.supported).toBe(true);
    expect(result.pages.map((entry) => entry.cursor)).toEqual([undefined, "v1.a", "v1.b"]);
  });

  it("asks at most its share of requests per press and leaves the cursor to continue from", async () => {
    const endless = Array.from({ length: 10 }, (_, index) => page([], `v1.${index}`));
    const pages = reader(endless);
    const result = await readBotThreadHistory({
      read: pages.read,
      from: "v1.start",
      listed: new Set(),
      wanted: 10,
    });
    expect(pages.asked).toHaveLength(BOT_THREAD_HISTORY_REQUESTS_PER_PRESS);
    expect(pages.asked[0]).toBe("v1.start");
    expect(result.pages.at(-1)?.result.history?.nextCursor).toBe("v1.3");
  });

  it("stops once a screenful of rows the list did not have came back", async () => {
    const pages = reader([
      page([task("listed"), task("new-1")], "v1.a"),
      page([task("new-2")], "v1.b"),
    ]);
    await readBotThreadHistory({
      read: pages.read,
      from: undefined,
      listed: new Set(["task:listed"]),
      wanted: 2,
    });
    expect(pages.asked).toEqual([undefined, "v1.a"]);
  });

  it("reports an answer without the history marker as a server that does not walk history", async () => {
    const pages = reader([{ rows: [], mainMessageCount: 0 }]);
    const result = await readBotThreadHistory({
      read: pages.read,
      from: undefined,
      listed: new Set(),
      wanted: 10,
    });
    expect(result).toEqual({ pages: [], supported: false });
  });
});
