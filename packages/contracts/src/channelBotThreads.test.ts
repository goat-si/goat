import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ChannelListBotThreadsResult, ChannelUpdateTaskViewInput } from "./channelGateway.ts";

const decodeRows = Schema.decodeUnknownSync(ChannelListBotThreadsResult);
const decodeUpdate = Schema.decodeUnknownSync(ChannelUpdateTaskViewInput);
const at = "2026-11-04T10:00:00.000Z";

describe("bot thread contracts", () => {
  it("decodes task views and coding destinations without the full ledger record", () => {
    const result = decodeRows({
      mainMessageCount: 10,
      rows: [
        {
          kind: "task",
          task: { taskId: "task-1", title: "Review", status: "waiting_input", updatedAt: at },
          view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
          lastActivityAt: at,
          unread: true,
          mainMessagesSinceQuiet: 9,
        },
        {
          kind: "coding",
          taskId: "task-1",
          environmentId: "env-1",
          threadId: "thread-1",
          state: "bound",
          lastActivityAt: at,
        },
      ],
    });
    expect(result.rows.map((row) => row.kind)).toEqual(["task", "coding"]);
    expect(
      decodeUpdate({ taskId: "task-1", pinned: true, done: false, readThrough: at }),
    ).toMatchObject({ pinned: true, done: false });
  });
  it("rejects malformed task views and negative message counts", () => {
    expect(() => decodeUpdate({ taskId: "task-1", readThrough: 42 })).toThrow();
    expect(() => decodeRows({ rows: [], mainMessageCount: -1 })).toThrow();
  });
});
