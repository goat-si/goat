import {
  BotId,
  BotRemoteWork,
  BotThreadRow,
  EnvironmentId,
  ThreadId,
  type ChannelListBotThreadsResult,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import { selectHomeCurrentOpenableWork } from "./homeCurrentOpenableWork.ts";
import { botRowRetiresAt } from "./taskVisibility.ts";
import {
  goatBotListedWork,
  goatBotObservationThreadKeys,
  type GoatBotVisibilityThread,
} from "./visibility.ts";

const source = EnvironmentId.make("source");
const remote = EnvironmentId.make("remote");
const caller = ThreadId.make("channel-bot:main");
const at = "2026-11-04T00:00:00.000Z";
const key = (environmentId: EnvironmentId, threadId: string) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)));
const row = Schema.decodeUnknownSync(BotThreadRow);
const remoteRow = Schema.decodeUnknownSync(BotRemoteWork);
const task = (id = "task", extra: object = {}) =>
  row({
    kind: "task",
    task: { taskId: id, title: id, status: "running", updatedAt: at },
    view: { taskId: id, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
    ...extra,
  });
const coding = (
  id: string,
  taskId = "task",
  environmentId = source,
  workKind: "coding" | "chore" = "coding",
) =>
  row({
    kind: "coding",
    taskId,
    environmentId,
    threadId: id,
    state: "bound",
    lastActivityAt: at,
    workKind,
  });
const launch = (id: string, workKind: "coding" | "chore" = "coding", taskId = "task") =>
  remoteRow({
    childWorkId: `child-${id}`,
    taskId,
    callerThreadId: caller,
    host: "host",
    state: "bound",
    lastActivityAt: at,
    environmentId: remote,
    threadId: id,
    workKind,
  });
const shell = (
  id: string,
  options: {
    env?: EnvironmentId;
    from?: string;
    fromEnv?: EnvironmentId | null;
    via?: "thread_launch" | "create_threads" | "ssh_thread_launch" | "delegate_task";
    kind?: "coding" | "chore";
    parent?: string;
  } = {},
): GoatBotVisibilityThread => ({
  environmentId: options.env ?? source,
  id: ThreadId.make(id),
  lineage: {
    parentThreadId: options.parent ? ThreadId.make(options.parent) : null,
    relationshipToParent: options.parent ? "subagent" : null,
  },
  source:
    options.from === undefined
      ? {}
      : {
          launchedBy: {
            kind: "launch",
            via: options.via ?? "thread_launch",
            threadId: ThreadId.make(options.from),
            environmentId: options.fromEnv ?? null,
            ...(options.kind ? { workKind: options.kind } : {}),
          },
        },
});
type Fixture = {
  name: string;
  rows: ReturnType<typeof row>[];
  remote?: ReturnType<typeof remoteRow>[];
  historyRows?: ReturnType<typeof row>[];
  historyRemote?: ReturnType<typeof remoteRow>[];
  threads: GoatBotVisibilityThread[];
  hidden: string[];
  offline?: boolean;
  list?: "ready" | "pending" | "failed";
  eligible?: boolean;
  legacy?: boolean;
  exception?: string[];
};
const workerTask = task("task", { worker: { environmentId: source, threadId: "worker" } });
const matching = (id: string, kind: "coding" | "chore" = "coding") =>
  shell(id, { env: remote, from: caller, fromEnv: source, via: "ssh_thread_launch", kind });
const fixtures: Fixture[] = [
  {
    name: "current task worker and coding",
    rows: [workerTask, coding("code")],
    threads: [shell("worker"), shell("code", { from: caller })],
    hidden: [key(source, "worker"), key(source, "code")],
  },
  {
    name: "current chat-turn coding",
    rows: [task("turn"), coding("turn-code", "turn")],
    threads: [shell("turn-code", { from: caller, via: "create_threads" })],
    hidden: [key(source, "turn-code")],
  },
  {
    name: "history-only turn",
    rows: [],
    historyRows: [task("old-task"), coding("old", "old-task")],
    threads: [shell("old", { from: caller })],
    hidden: [],
  },
  ...(["chore", "coding"] as const).map((kind) => ({
    name: `remote ${kind} matching provenance`,
    rows: [task()],
    remote: [launch(`remote-${kind}`, kind)],
    threads: [matching(`remote-${kind}`, kind)],
    hidden: [key(remote, `remote-${kind}`)],
  })),
  {
    name: "remote different caller",
    rows: [task()],
    remote: [launch("wrong")],
    threads: [
      shell("wrong", { env: remote, from: "other", fromEnv: source, via: "ssh_thread_launch" }),
    ],
    hidden: [],
  },
  {
    name: "remote missing launcher environment",
    rows: [task()],
    remote: [launch("missing")],
    threads: [shell("missing", { env: remote, from: caller, via: "ssh_thread_launch" })],
    hidden: [],
  },
  {
    name: "remote destination disconnected",
    rows: [task()],
    remote: [launch("offline")],
    threads: [matching("offline")],
    hidden: [],
    offline: true,
  },
  {
    name: "equal ids in two environments",
    rows: [task(), coding("same")],
    threads: [shell("same"), shell("same", { env: remote, from: caller, via: "thread_launch" })],
    hidden: [key(source, "same")],
  },
  {
    name: "more than 20 history-only launches",
    rows: [],
    historyRows: [
      task("old-task"),
      ...Array.from({ length: 25 }, (_, i) => coding(`old-${i}`, "old-task")),
    ],
    threads: Array.from({ length: 25 }, (_, i) => shell(`old-${i}`, { from: caller })),
    hidden: [],
  },
  {
    name: "released remote outside current list",
    rows: [task()],
    historyRemote: [
      remoteRow({
        childWorkId: "released",
        taskId: "task",
        callerThreadId: caller,
        host: "host",
        state: "released",
        lastActivityAt: at,
        environmentId: remote,
        threadId: "released",
      }),
    ],
    threads: [matching("released")],
    hidden: [],
  },
  {
    name: "retired task leaves current list",
    rows: [
      task("retired", {
        task: {
          taskId: "retired",
          title: "retired",
          status: "completed",
          updatedAt: at,
          completedAt: at,
        },
        view: { taskId: "retired", pinnedAt: null, doneAt: at, readThrough: null },
        worker: { environmentId: source, threadId: "retired-worker" },
      }),
    ].filter((item) => botRowRetiresAt(item) > Date.parse("2026-11-10T00:00:00Z")),
    threads: [shell("retired-worker")],
    hidden: [],
  },
  ...(["pending", "failed"] as const).map((list) => ({
    name: `${list} list`,
    rows: [workerTask],
    threads: [shell("worker")],
    hidden: [],
    list,
  })),
  {
    name: "ineligible bot",
    rows: [workerTask],
    threads: [shell("worker")],
    hidden: [],
    eligible: false,
  },
  {
    name: "delegated child top-level launch",
    rows: [],
    threads: [
      shell("delegate", { from: caller, via: "delegate_task" }),
      shell("launched", { from: "delegate" }),
    ],
    hidden: [key(source, "delegate")],
    exception: [key(source, "delegate")],
  },
  {
    name: "linked delegated child's top-level launch",
    rows: [task(), coding("launched")],
    threads: [
      shell("delegate", { from: caller, via: "delegate_task" }),
      shell("launched", { from: "delegate" }),
    ],
    hidden: [key(source, "delegate"), key(source, "launched")],
    exception: [key(source, "delegate")],
  },
  {
    name: "delegate and subagent observation",
    rows: [],
    threads: [
      shell("delegate", { from: caller, via: "delegate_task" }),
      shell("sub", { parent: caller }),
    ],
    hidden: [key(source, "delegate"), key(source, "sub")],
    exception: [key(source, "delegate"), key(source, "sub")],
  },
  {
    name: "older server keeps chore-only behavior",
    rows: [task(), coding("chore", "task", source, "chore"), coding("code")],
    threads: [
      shell("chore", { from: caller, kind: "chore" }),
      shell("code", { from: caller, kind: "coding" }),
    ],
    hidden: [key(source, "chore")],
    legacy: true,
  },
];

describe("Home and Threads two-way visibility", () => {
  it.each(fixtures)("$name", (fixture) => {
    const result: ChannelListBotThreadsResult = {
      rows: fixture.rows,
      mainMessageCount: 0,
      ...(fixture.remote ? { remoteWork: fixture.remote } : {}),
    };
    if (fixture.historyRows)
      expect(fixture.historyRows.length).toBeGreaterThan(fixture.rows.length);
    if (fixture.historyRemote) expect(fixture.historyRemote[0]?.state).toBe("released");
    const value = selectHomeCurrentOpenableWork({
      sourceEnvironmentId: source,
      botId: BotId.make("main"),
      eligible: fixture.eligible ?? true,
      list: fixture.list ?? "ready",
      current: result,
      isOpenable: (id) => !fixture.offline || id !== remote,
    });
    const union = {
      rosterKnown: true,
      byBot: [{ botId: BotId.make("main"), eligible: value.eligible, list: value.list }],
      links: value.links,
    };
    const hidden = goatBotObservationThreadKeys({
      threads: fixture.threads,
      homeWork: fixture.legacy ? [] : union.links,
      listedWork: fixture.legacy ? goatBotListedWork(fixture.rows) : [],
    });
    const actual = fixture.threads
      .map((thread) => key(thread.environmentId, thread.id))
      .filter((id) => hidden.has(id));
    expect(actual.toSorted()).toEqual(fixture.hidden.toSorted());
    if (!fixture.legacy)
      for (const thread of fixture.threads) {
        const id = key(thread.environmentId, thread.id);
        if (hidden.has(id) && !fixture.exception?.includes(id))
          expect(
            union.links.some(
              (link) =>
                key(link.environmentId, link.threadId) === id &&
                (link.kind !== "remote" ||
                  (thread.source.launchedBy?.via === "ssh_thread_launch" &&
                    thread.source.launchedBy.environmentId === link.launchedFrom?.environmentId &&
                    thread.source.launchedBy.threadId === link.launchedFrom?.threadId)),
            ),
          ).toBe(true);
      }
    if (!fixture.legacy)
      for (const link of union.links.filter((entry) => entry.kind !== "remote"))
        if (
          fixture.threads.some(
            (thread) =>
              key(thread.environmentId, thread.id) === key(link.environmentId, link.threadId),
          )
        )
          expect(hidden.has(key(link.environmentId, link.threadId))).toBe(true);
    if (fixture.name.startsWith("remote ") && fixture.name.includes("matching"))
      expect(
        goatBotObservationThreadKeys({ threads: fixture.threads, homeWork: [] }).has(
          fixture.hidden[0] ?? "",
        ),
      ).toBe(false);
  });
});
