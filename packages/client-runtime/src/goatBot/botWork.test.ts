import { describe, expect, it } from "@effect/vitest";
import { BotRemoteWork, BotThreadRow, ChannelChildWorkGroup, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { groupBotWork } from "./botWork.ts";

const row = Schema.decodeUnknownSync(BotThreadRow);
const group = Schema.decodeUnknownSync(ChannelChildWorkGroup);
const at = "2026-11-04T00:00:00.000Z";
const task = (id: string, doneAt: string | null) =>
  row({
    kind: "task",
    task: { taskId: id, title: id, status: "running", updatedAt: at },
    view: { taskId: id, doneAt, pinnedAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
const coding = row({
  kind: "coding",
  taskId: "a",
  environmentId: "env",
  threadId: "thread",
  state: "bound",
  lastActivityAt: at,
});
const children = group({
  taskId: "a",
  truncated: true,
  children: [
    {
      childWorkId: "sub",
      ownerId: "owner",
      taskId: "a",
      generation: 1,
      surface: "delegate_remote",
      callerThreadId: "caller",
      requestKey: "request",
      promptDigest: "digest",
      destinationHint: "remote",
      state: "unknown",
      destination: { host: "host" },
      createdAt: at,
      updatedAt: at,
    },
    {
      childWorkId: "launch",
      ownerId: "owner",
      taskId: "a",
      generation: 1,
      surface: "thread_launch",
      callerThreadId: "caller",
      requestKey: "request2",
      promptDigest: "digest",
      state: "bound",
      destination: { threadId: "thread" },
      createdAt: at,
      updatedAt: at,
    },
  ],
});

describe("groupBotWork", () => {
  it("groups tasks, preserves uncertain delegates and deduplicates linked threads", () => {
    const result = groupBotWork(
      [task("a", null), task("b", at), coding],
      [children],
      EnvironmentId.make("env"),
    );
    expect(result.inProgress).toHaveLength(1);
    expect(result.done).toHaveLength(1);
    expect(result.inProgress[0]?.subagents).toEqual([
      {
        childWorkId: "sub",
        state: "unknown",
        label: "uncertain",
        host: "host",
        destinationHint: "remote",
      },
    ]);
    expect(result.inProgress[0]?.threads).toEqual([{ environmentId: "env", threadId: "thread" }]);
    expect(result.inProgress[0]?.truncated).toBe(true);
  });

  it("opens a task's worker from its task, since thread lists leave it to the bot", () => {
    const withWorker = (threadId: string) =>
      row({ ...task("a", null), worker: { environmentId: "env", threadId } });
    const threadsOf = (taskRow: ReturnType<typeof withWorker>) =>
      groupBotWork([taskRow], [], EnvironmentId.make("env")).inProgress[0]?.threads;
    expect(threadsOf(withWorker("channel-worker:a"))).toEqual([
      { environmentId: "env", threadId: "channel-worker:a" },
    ]);
    // A bot turn runs in the bot's own conversation, which is the chat already open.
    expect(threadsOf(withWorker("goat-bot-session:a"))).toEqual([]);
  });

  it("lists a task's work on other machines with that task only", () => {
    const remote = Schema.decodeUnknownSync(BotRemoteWork);
    const onBox = remote({
      childWorkId: "cw-box",
      taskId: "a",
      callerThreadId: "channel-worker:a",
      host: "box",
      state: "bound",
      lastActivityAt: at,
      threadId: "remote-thread",
      environmentId: "env-box",
      workKind: "chore",
    });
    const otherTask = remote({ ...onBox, childWorkId: "cw-b", taskId: "b" });
    const result = groupBotWork([task("a", null)], [], EnvironmentId.make("env"), [
      onBox,
      otherTask,
    ]);
    expect(result.inProgress[0]?.remote).toEqual([onBox]);
    // A remote thread is never opened in the bot's own environment.
    expect(result.inProgress[0]?.threads).toEqual([]);
  });
});
