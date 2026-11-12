import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ChannelChildWork } from "./channelChildWork.ts";
import {
  ChannelListBotThreadsInput,
  ChannelListBotThreadsResult,
  ChannelUpdateTaskViewInput,
} from "./channelGateway.ts";
import { BotId } from "./botProfile.ts";

const decodeRows = Schema.decodeUnknownSync(ChannelListBotThreadsResult);
const decodeUpdate = Schema.decodeUnknownSync(ChannelUpdateTaskViewInput);
const decodeChild = Schema.decodeUnknownSync(ChannelChildWork);
const encodeChild = Schema.encodeSync(ChannelChildWork);
// The result as clients before remoteWork decoded it.
const decodeRowsBefore = Schema.decodeUnknownSync(
  Schema.Struct({
    rows: ChannelListBotThreadsResult.fields.rows,
    mainMessageCount: ChannelListBotThreadsResult.fields.mainMessageCount,
  }),
);
const at = "2026-11-04T10:00:00.000Z";

describe("bot thread contracts", () => {
  it("bounds a history cursor, and an older server's input drops the history key", () => {
    const decodeInput = Schema.decodeUnknownSync(ChannelListBotThreadsInput);
    expect(
      decodeInput({ history: { cursor: "v1." + "a".repeat(509) } }).history?.cursor,
    ).toHaveLength(512);
    expect(() => decodeInput({ history: { cursor: "v1." + "a".repeat(510) } })).toThrow();
    // RpcServer decodes payloads with the default onExcessProperty, "ignore".
    const decodeOlder = Schema.decodeUnknownSync(
      Schema.Struct({ botId: Schema.optionalKey(BotId) }),
    );
    expect(decodeOlder({ botId: "helper", history: { cursor: "v1.x" } })).toEqual({
      botId: "helper",
    });
  });

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
          title: "",
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
  it("carries the bot's work on other machines beside its rows, which older clients ignore", () => {
    const remoteWork = [
      {
        childWorkId: "cw-1",
        taskId: "task-1",
        callerThreadId: "channel-worker:task-1",
        host: "box",
        state: "bound",
        lastActivityAt: at,
        threadId: "thread-1",
        environmentId: "env-box",
        workKind: "chore",
      },
      {
        childWorkId: "cw-2",
        taskId: "task-1",
        callerThreadId: "channel-worker:task-1",
        host: "mac",
        state: "unknown",
        lastActivityAt: at,
      },
    ];
    expect(decodeRows({ rows: [], mainMessageCount: 0, remoteWork }).remoteWork).toEqual(
      remoteWork,
    );
    expect(decodeRows({ rows: [], mainMessageCount: 0 }).remoteWork).toBeUndefined();
    expect(decodeRowsBefore({ rows: [], mainMessageCount: 0, remoteWork })).toEqual({
      rows: [],
      mainMessageCount: 0,
    });
  });
  it("reads child work records stored before destinations kept a remote identity", () => {
    const stored = {
      childWorkId: "cw-1",
      ownerId: "owner",
      taskId: "task-1",
      generation: 1,
      surface: "ssh_thread_launch",
      callerThreadId: "channel-worker:task-1",
      requestKey: "key",
      promptDigest: "digest",
      state: "bound",
      destination: { correlationId: "cw-corr", host: "box" },
      createdAt: at,
      updatedAt: at,
    };
    expect(decodeChild(stored).destination).toEqual({ correlationId: "cw-corr", host: "box" });
    const bound = {
      ...stored,
      destination: {
        ...stored.destination,
        threadId: "thread-1",
        environmentId: "env-box",
        workKind: "chore",
      },
    };
    expect(encodeChild(decodeChild(bound))).toEqual(bound);
  });
});
