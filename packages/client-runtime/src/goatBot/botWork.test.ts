import { describe, expect, it } from "@effect/vitest";
import {
  BotRemoteWork,
  BotThreadRow,
  ChannelChildWorkGroup,
  ChannelTaskId,
  EnvironmentId,
  type ChannelTaskChip,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { botHomeWork, COLLAPSED_FINISHED, groupBotWork, workRowCollapsed } from "./botWork.ts";

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

const statusRow = (
  id: string,
  status: string,
  lastActivityAt: string,
  doneAt: string | null = null,
) =>
  row({
    kind: "task",
    task: { taskId: id, title: id, status, updatedAt: lastActivityAt },
    view: { taskId: id, doneAt, pinnedAt: null, readThrough: null },
    lastActivityAt,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });

describe("botHomeWork", () => {
  it("orders the bot's work running, then waiting, then recently finished", () => {
    const home = botHomeWork(
      [
        statusRow("done-new", "completed", "2026-11-04T05:00:00.000Z"),
        statusRow("waiting-old", "waiting_input", "2026-11-04T01:00:00.000Z"),
        statusRow("running-old", "running", "2026-11-04T02:00:00.000Z"),
        statusRow("running-new", "running", "2026-11-04T04:00:00.000Z"),
        statusRow("done-old", "failed", "2026-11-04T03:00:00.000Z"),
      ],
      [],
      EnvironmentId.make("env"),
    );
    const ids = (tasks: ReadonlyArray<{ row: { task: { taskId: string } } }>) =>
      tasks.map((task) => task.row.task.taskId);
    expect(ids(home.running)).toEqual(["running-new", "running-old"]);
    expect(ids(home.waiting)).toEqual(["waiting-old"]);
    expect(ids(home.finished)).toEqual(["done-new", "done-old"]);
  });

  it("keeps a task a person marked done out of the running group", () => {
    const home = botHomeWork(
      [statusRow("marked", "running", "2026-11-04T02:00:00.000Z", "2026-11-04T03:00:00.000Z")],
      [],
      EnvironmentId.make("env"),
    );
    expect(home.running).toEqual([]);
    expect(home.finished).toHaveLength(1);
  });

  it("leaves coding rows to their task, as the work groups do", () => {
    const home = botHomeWork([coding], [], EnvironmentId.make("env"));
    expect([...home.running, ...home.waiting, ...home.finished]).toEqual([]);
  });

  // Regression: Home said Working while the face and activity line said the task waits on you.
  it("puts a task with work waiting on a person when its worker asks something, as the face counts it", () => {
    const since = "2026-11-04T00:30:00.000Z";
    const chip = (id: string, status: string, needs: ReadonlyArray<string>) =>
      [
        ChannelTaskId.make(id),
        {
          taskId: id,
          taskVersion: 2,
          status,
          openQuestionCount: 0,
          observed: { pullRequests: [], needsYou: needs.map((kind) => ({ kind, since })) },
        } as unknown as ChannelTaskChip,
      ] as const;
    const home = botHomeWork(
      [
        statusRow("asks", "running", "2026-11-04T01:00:00.000Z"),
        statusRow("approve", "running", "2026-11-04T02:00:00.000Z"),
        statusRow("quiet", "running", "2026-11-04T03:00:00.000Z"),
        statusRow("done", "completed", "2026-11-04T04:00:00.000Z"),
        statusRow("marked", "running", "2026-11-04T05:00:00.000Z", "2026-11-04T05:30:00.000Z"),
      ],
      [],
      EnvironmentId.make("env"),
      [],
      new Map([
        chip("asks", "running", ["question"]),
        chip("approve", "running", ["approval"]),
        chip("quiet", "running", []),
        chip("done", "completed", ["question"]),
        chip("marked", "running", ["question"]),
      ]),
    );
    const ids = (tasks: ReadonlyArray<{ row: { task: { taskId: string } } }>) =>
      tasks.map((task) => task.row.task.taskId);
    expect(ids(home.waiting)).toEqual(["approve", "asks"]);
    expect(ids(home.running)).toEqual(["quiet"]);
    // A finished task's stale question and a task the person marked done wait on nothing.
    expect(ids(home.finished)).toEqual(["done", "marked"]);
  });

  it("keeps finished work whose approval is still open with work waiting, as the face does", () => {
    const home = botHomeWork(
      [statusRow("approval-left", "completed", "2026-11-04T01:00:00.000Z")],
      [],
      EnvironmentId.make("env"),
      [],
      new Map([
        [
          ChannelTaskId.make("approval-left"),
          {
            taskId: "approval-left",
            taskVersion: 3,
            status: "completed",
            openQuestionCount: 0,
            observed: {
              pullRequests: [],
              needsYou: [{ kind: "approval", since: "2026-11-04T00:30:00.000Z" }],
            },
          } as unknown as ChannelTaskChip,
        ],
      ]),
    );
    expect(home.waiting.map((task) => task.row.task.taskId)).toEqual(["approval-left"]);
    expect(home.finished).toEqual([]);
  });
});

describe("workRowCollapsed", () => {
  // Back from a peek opened Show more for a row Home lists under waiting, not behind Show more.
  it("does not hold finished work with an open approval behind Show more, since Home lists it as waiting", () => {
    const finished = Array.from({ length: COLLAPSED_FINISHED + 1 }, (_, index) =>
      statusRow(`done-${index}`, "completed", "2026-11-04T05:00:00.000Z"),
    );
    const rows = [...finished, statusRow("approval-left", "completed", "2026-11-04T01:00:00.000Z")];
    const chips = new Map([
      [
        ChannelTaskId.make("approval-left"),
        {
          taskId: "approval-left",
          taskVersion: 3,
          status: "completed",
          openQuestionCount: 0,
          observed: {
            pullRequests: [],
            needsYou: [{ kind: "approval", since: "2026-11-04T00:30:00.000Z" }],
          },
        } as unknown as ChannelTaskChip,
      ],
    ]);
    const env = EnvironmentId.make("env");
    const id = ChannelTaskId.make("approval-left");
    expect(workRowCollapsed(rows, env, [], id, chips)).toBe(false);
    // Without the chip the row is finished and sits past the collapsed tail.
    expect(workRowCollapsed(rows, env, [], id)).toBe(true);
  });
});
