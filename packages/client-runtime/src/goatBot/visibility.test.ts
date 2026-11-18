import {
  ChannelChildWorkId,
  EnvironmentId,
  ThreadId,
  type BotRemoteWork,
  type BotThreadRow,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import { resolveRemoteBotWork } from "./remoteWork.ts";
import {
  goatBotListedWork,
  goatBotObservationThreadKeys,
  type GoatBotVisibilityThread,
  type GoatBotWorkRef,
} from "./visibility.ts";

const HOME = EnvironmentId.make("environment-home");
const REMOTE = EnvironmentId.make("environment-remote");

type Via = "thread_launch" | "create_threads" | "ssh_thread_launch" | "delegate_task";

function thread(
  id: string,
  options: {
    readonly environmentId?: EnvironmentId;
    readonly subagentOf?: string;
    readonly launchedBy?: string;
    readonly launcherEnvironment?: EnvironmentId;
    readonly via?: Via;
    readonly promoted?: boolean;
    readonly workKind?: "coding" | "chore";
  } = {},
): GoatBotVisibilityThread {
  return {
    environmentId: options.environmentId ?? HOME,
    id: ThreadId.make(id),
    lineage: {
      parentThreadId: options.subagentOf === undefined ? null : ThreadId.make(options.subagentOf),
      relationshipToParent: options.subagentOf === undefined ? null : "subagent",
    },
    source:
      options.launchedBy === undefined
        ? {}
        : {
            launchedBy: {
              kind: options.promoted === true ? "promotion" : "launch",
              threadId: ThreadId.make(options.launchedBy),
              environmentId: options.launcherEnvironment ?? null,
              via: options.via ?? "thread_launch",
              ...(options.workKind === undefined ? {} : { workKind: options.workKind }),
            },
          },
  };
}

const NOW = "2026-11-09T00:00:00.000Z";

function launchRow(
  id: string,
  workKind: "coding" | "chore" | undefined,
  environmentId = HOME,
): BotThreadRow {
  return {
    kind: "coding",
    taskId: "channel-task:a" as never,
    environmentId,
    threadId: ThreadId.make(id),
    state: "bound",
    lastActivityAt: NOW,
    ...(workKind === undefined ? {} : { workKind }),
  };
}

function taskRow(worker?: { readonly id: string; readonly environmentId?: EnvironmentId }) {
  return {
    kind: "task",
    task: {
      taskId: "channel-task:a" as never,
      title: "Stop the port 3774 server",
      status: "running",
      updatedAt: NOW,
    },
    view: { taskId: "channel-task:a" as never, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: NOW,
    unread: false,
    mainMessagesSinceQuiet: 0,
    ...(worker === undefined
      ? {}
      : {
          worker: {
            environmentId: worker.environmentId ?? HOME,
            threadId: ThreadId.make(worker.id),
          },
        }),
  } as BotThreadRow;
}

const key = (id: string, environmentId = HOME) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));

const hidden = (
  threads: ReadonlyArray<GoatBotVisibilityThread>,
  rows?: ReadonlyArray<BotThreadRow>,
) => {
  const listedWork: ReadonlyArray<GoatBotWorkRef> | undefined =
    rows === undefined ? undefined : goatBotListedWork(rows);
  return [...goatBotObservationThreadKeys({ threads, ...(listedWork ? { listedWork } : {}) })]
    .filter((entry) => threads.some((t) => key(t.id, t.environmentId) === entry))
    .toSorted();
};

const SESSION = "goat-bot-session:conversation";

describe("goatBotObservationThreadKeys", () => {
  it("hides session threads by their id prefix only", () => {
    expect(hidden([thread(SESSION), thread("not-goat-bot-session:x")])).toEqual([key(SESSION)]);
  });

  it("regression GB-W-01: hides the main bot's and member bots' conversation threads by id", () => {
    const threads = [
      thread("channel-bot:main"),
      thread("channel-member-bot:member"),
      thread("channel-bot-ish"),
      thread("member-observer", { subagentOf: "channel-member-bot:member" }),
    ];
    expect(hidden(threads)).toEqual(
      [
        key("channel-bot:main"),
        key("channel-member-bot:member"),
        key("member-observer"),
      ].toSorted(),
    );
  });

  it("hides a chore the bot launched once its rows list it, and keeps coding it launched visible", () => {
    const threads = [
      thread(SESSION),
      thread("channel-child-work:chore", { launchedBy: SESSION, workKind: "chore" }),
      thread("chore-subagent", { subagentOf: "channel-child-work:chore" }),
      thread("channel-child-work:coding", { launchedBy: SESSION, workKind: "coding" }),
    ];
    const rows = [
      taskRow(),
      launchRow("channel-child-work:chore", "chore"),
      launchRow("channel-child-work:coding", "coding"),
    ];
    expect(hidden(threads, rows)).toEqual(
      [key(SESSION), key("channel-child-work:chore"), key("chore-subagent")].toSorted(),
    );
  });

  it("keeps a chore visible before the bot's rows load and when the rows leave it out", () => {
    const threads = [
      thread("channel-child-work:chore", { launchedBy: SESSION, workKind: "chore" }),
    ];
    // Not loaded yet, then loaded without its row (past retention or the row limit).
    expect(hidden(threads)).toEqual([]);
    expect(hidden(threads, [taskRow()])).toEqual([]);
    expect(hidden(threads, [launchRow("channel-child-work:chore", "chore")])).toEqual([
      key("channel-child-work:chore"),
    ]);
  });

  it("keeps a listed launch without a work kind visible; the server marks old scratch rows", () => {
    const threads = [thread("channel-child-work:old", { launchedBy: SESSION })];
    expect(hidden(threads, [launchRow("channel-child-work:old", undefined)])).toEqual([]);
  });

  it("hides a task's worker the bot lists, only in the worker's own environment", () => {
    const threads = [
      thread("channel-worker:a"),
      thread("channel-worker:a", { environmentId: REMOTE }),
      thread("worker-subagent", { subagentOf: "channel-worker:a" }),
    ];
    expect(hidden(threads, [taskRow({ id: "channel-worker:a" })])).toEqual(
      [key("channel-worker:a"), key("worker-subagent")].toSorted(),
    );
  });

  it("keeps a channel worker visible when no GOAT conversation row lists it, as for Slack", () => {
    expect(hidden([thread("channel-worker:slack")], [taskRow()])).toEqual([]);
  });

  it("matches a listed launch only in the environment the row names", () => {
    const threads = [
      thread("channel-child-work:chore", {
        environmentId: REMOTE,
        launchedBy: SESSION,
        workKind: "chore",
      }),
    ];
    expect(hidden(threads, [launchRow("channel-child-work:chore", "chore")])).toEqual([]);
  });

  it("hides subagents below a session", () => {
    const threads = [
      thread(SESSION),
      thread("observer", { subagentOf: SESSION }),
      thread("nested", { subagentOf: "observer" }),
    ];
    expect(hidden(threads)).toEqual([key(SESSION), key("observer"), key("nested")].toSorted());
  });

  it("follows delegated launches to another machine that has no parent lineage", () => {
    const threads = [
      thread(SESSION),
      thread("remote-task", {
        environmentId: REMOTE,
        launchedBy: SESSION,
        launcherEnvironment: HOME,
        via: "delegate_task",
      }),
      thread("remote-nested", {
        environmentId: REMOTE,
        launchedBy: "remote-task",
        via: "delegate_task",
      }),
    ];
    expect(hidden(threads)).toEqual(
      [key(SESSION), key("remote-task", REMOTE), key("remote-nested", REMOTE)].toSorted(),
    );
  });

  it("recognizes a delegating session that is not loaded on this client", () => {
    const threads = [
      thread("remote-task", {
        environmentId: REMOTE,
        launchedBy: SESSION,
        launcherEnvironment: HOME,
        via: "delegate_task",
      }),
    ];
    expect(hidden(threads)).toEqual([key("remote-task", REMOTE)]);
  });

  it("stops at coding work a session launched; its own children keep today's folding", () => {
    const threads = [
      thread(SESSION),
      thread("worktree", { launchedBy: SESSION, via: "thread_launch" }),
      thread("ssh-work", { launchedBy: SESSION, via: "ssh_thread_launch", workKind: "chore" }),
      thread("worktree-task", { launchedBy: "worktree", via: "delegate_task" }),
      thread("worktree-subagent", { subagentOf: "worktree" }),
    ];
    expect(hidden(threads, [taskRow()])).toEqual([key(SESSION)]);
  });

  it("stops at a thread the user promoted to top level, even when a row lists it", () => {
    const threads = [
      thread(SESSION),
      thread("promoted", { launchedBy: SESSION, promoted: true }),
      thread("promoted-task", { launchedBy: "promoted", via: "delegate_task" }),
    ];
    expect(hidden(threads, [launchRow("promoted", "chore")])).toEqual([key(SESSION)]);
  });

  it("leaves every child of a person's thread to today's folding", () => {
    const threads = [
      thread("user-thread"),
      thread("task", {
        subagentOf: "user-thread",
        launchedBy: "user-thread",
        via: "delegate_task",
      }),
      thread("launched", { launchedBy: "user-thread" }),
      thread("fork"),
    ];
    expect(hidden(threads)).toEqual([]);
  });

  it("does not carry a session's children to the same id in another environment", () => {
    const threads = [
      thread(SESSION),
      thread("observer", { subagentOf: SESSION }),
      thread("observer", {
        environmentId: REMOTE,
        launchedBy: "user-thread",
        via: "delegate_task",
      }),
    ];
    expect(hidden(threads)).toEqual([key(SESSION), key("observer")].toSorted());
  });

  it("ends on launch loops from copied databases without hiding them", () => {
    const loop = [
      thread("a", { launchedBy: "b", via: "delegate_task" }),
      thread("b", { launchedBy: "a", via: "delegate_task" }),
    ];
    expect(hidden(loop)).toEqual([]);
    expect(
      hidden(
        [...loop, thread("c", { subagentOf: SESSION }), thread(SESSION)].concat(
          thread("a2", { launchedBy: "c", via: "delegate_task" }),
          thread("b2", { launchedBy: "a2", via: "delegate_task" }),
        ),
      ),
    ).toEqual([key(SESSION), key("a2"), key("b2"), key("c")].toSorted());
  });
});

const BOX = EnvironmentId.make("environment-box");
const WORKER = "channel-worker:task-a";

function remoteItem(
  options: {
    readonly id?: string;
    readonly threadId?: string | null;
    readonly environmentId?: EnvironmentId | null;
    readonly workKind?: "coding" | "chore" | null;
    readonly state?: BotRemoteWork["state"];
  } = {},
): BotRemoteWork {
  return {
    childWorkId: ChannelChildWorkId.make(options.id ?? "cw-remote"),
    taskId: "channel-task:a" as never,
    callerThreadId: ThreadId.make(WORKER),
    host: "box",
    state: options.state ?? "bound",
    lastActivityAt: NOW,
    ...(options.threadId === null
      ? {}
      : { threadId: ThreadId.make(options.threadId ?? "remote-chore") }),
    ...(options.environmentId === null ? {} : { environmentId: options.environmentId ?? BOX }),
    ...(options.workKind === null ? {} : { workKind: options.workKind ?? "chore" }),
  };
}

/** The destination's own record of the launch, as goat_ssh_thread_launch forwards it. */
const remoteChore = (
  id = "remote-chore",
  options: {
    readonly environmentId?: EnvironmentId;
    /** null: a destination that never recorded one. */
    readonly workKind?: "coding" | "chore" | null;
    readonly launcherEnvironment?: EnvironmentId;
    readonly launchedBy?: string;
    readonly via?: Via;
    readonly promoted?: boolean;
  } = {},
) =>
  thread(id, {
    environmentId: options.environmentId ?? BOX,
    launchedBy: options.launchedBy ?? WORKER,
    launcherEnvironment: options.launcherEnvironment ?? HOME,
    via: options.via ?? "ssh_thread_launch",
    ...(options.workKind === null ? {} : { workKind: options.workKind ?? "chore" }),
    ...(options.promoted === true ? { promoted: true } : {}),
  });

const hiddenRemote = (
  threads: ReadonlyArray<GoatBotVisibilityThread>,
  items: ReadonlyArray<BotRemoteWork>,
  openable: ReadonlyArray<EnvironmentId> = [BOX],
) => {
  const listedWork = goatBotListedWork([taskRow()], {
    originEnvironmentId: HOME,
    items,
    isOpenable: (environmentId) => openable.includes(environmentId),
  });
  return [...goatBotObservationThreadKeys({ threads, listedWork })]
    .filter((entry) => threads.some((t) => key(t.id, t.environmentId) === entry))
    .toSorted();
};

describe("GOAT Bot work on another machine", () => {
  it("hides a chore on a connected machine whose own launcher names this bot's task", () => {
    const threads = [
      remoteChore(),
      thread("chore-subagent", { environmentId: BOX, subagentOf: "remote-chore" }),
    ];
    expect(hiddenRemote(threads, [remoteItem()])).toEqual(
      [key("remote-chore", BOX), key("chore-subagent", BOX)].toSorted(),
    );
  });

  it("keeps it visible while its machine is disconnected, and hides it again on reconnect", () => {
    const threads = [remoteChore()];
    expect(hiddenRemote(threads, [remoteItem()], [])).toEqual([]);
    expect(hiddenRemote(threads, [remoteItem()], [BOX])).toEqual([key("remote-chore", BOX)]);
  });

  it("keeps it visible when the origin could not prove the destination's identity", () => {
    const threads = [remoteChore()];
    expect(hiddenRemote(threads, [remoteItem({ environmentId: null })])).toEqual([]);
    expect(hiddenRemote(threads, [remoteItem({ threadId: null })])).toEqual([]);
  });

  it("keeps it visible when the destination never recorded the chore, as an older GOAT drops it", () => {
    expect(hiddenRemote([remoteChore("remote-chore", { workKind: null })], [remoteItem()])).toEqual(
      [],
    );
    expect(
      hiddenRemote([remoteChore("remote-chore", { workKind: "coding" })], [remoteItem()]),
    ).toEqual([]);
  });

  it("keeps it visible when the destination's launcher is another thread, machine or route", () => {
    for (const shell of [
      remoteChore("remote-chore", { launchedBy: "channel-worker:other" }),
      remoteChore("remote-chore", { launcherEnvironment: REMOTE }),
      remoteChore("remote-chore", { via: "thread_launch" }),
    ]) {
      expect(hiddenRemote([shell], [remoteItem()])).toEqual([]);
    }
  });

  it("keeps coding and unclassified work visible", () => {
    const threads = [remoteChore()];
    expect(hiddenRemote(threads, [remoteItem({ workKind: "coding" })])).toEqual([]);
    expect(hiddenRemote(threads, [remoteItem({ workKind: null })])).toEqual([]);
  });

  it("keeps a promoted thread visible even though the bot still lists the chore", () => {
    expect(hiddenRemote([remoteChore("remote-chore", { promoted: true })], [remoteItem()])).toEqual(
      [],
    );
  });

  it("hides only the thread in the named environment when the same id exists elsewhere", () => {
    const threads = [
      remoteChore(),
      remoteChore("remote-chore", { environmentId: REMOTE }),
      thread("remote-chore", { launchedBy: WORKER, workKind: "chore" }),
    ];
    expect(hiddenRemote(threads, [remoteItem()], [BOX, REMOTE, HOME])).toEqual([
      key("remote-chore", BOX),
    ]);
  });

  it("forgets a hidden chore once the bot's rows no longer list it", () => {
    expect(hiddenRemote([remoteChore()], [])).toEqual([]);
  });
});

describe("resolveRemoteBotWork", () => {
  it("opens the destination thread only on a connected machine with a proven identity", () => {
    const openable = (environmentId: EnvironmentId) => environmentId === BOX;
    expect(resolveRemoteBotWork(remoteItem(), openable)).toEqual({
      kind: "open",
      host: "box",
      ref: { environmentId: BOX, threadId: ThreadId.make("remote-chore") },
    });
    for (const item of [
      remoteItem({ environmentId: REMOTE }),
      remoteItem({ environmentId: null }),
      remoteItem({ threadId: null }),
    ]) {
      expect(resolveRemoteBotWork(item, openable)).toEqual({
        kind: "unavailable",
        host: "box",
        label: "Unavailable",
      });
    }
  });

  it("says how a launch that lost its host or was dismissed ended, and never opens it", () => {
    const openable = () => true;
    for (const [state, label] of [
      ["failed", "Failed"],
      ["cancelled", "Cancelled"],
      ["released", "Not started"],
      ["completed", "Finished"],
    ] as const) {
      const item = remoteItem({ state, environmentId: null, threadId: null });
      expect(resolveRemoteBotWork(item, openable)).toEqual({
        kind: "unavailable",
        host: "box",
        label,
      });
    }
  });
});

it("hides current Home links only with matching remote launcher provenance", () => {
  const refs = [
    {
      taskId: "task" as never,
      environmentId: HOME,
      threadId: ThreadId.make("worker"),
      kind: "worker" as const,
    },
    {
      taskId: "task" as never,
      environmentId: HOME,
      threadId: ThreadId.make("coding"),
      kind: "coding" as const,
    },
    ...["remote-coding", "wrong", "missing"].map((id) => ({
      taskId: "task" as never,
      environmentId: REMOTE,
      threadId: ThreadId.make(id),
      kind: "remote" as const,
      launchedFrom: { environmentId: HOME, threadId: ThreadId.make(SESSION) },
    })),
  ];
  const threads = [
    thread("worker"),
    thread("coding", { launchedBy: SESSION, workKind: "coding" }),
    thread("remote-coding", {
      environmentId: REMOTE,
      launchedBy: SESSION,
      launcherEnvironment: HOME,
      via: "ssh_thread_launch",
      workKind: "coding",
    }),
    thread("wrong", {
      environmentId: REMOTE,
      launchedBy: "someone-else",
      launcherEnvironment: HOME,
      via: "ssh_thread_launch",
    }),
    thread("missing", { environmentId: REMOTE, launchedBy: SESSION, via: "ssh_thread_launch" }),
  ];
  const visibleKeys = (links: typeof refs) =>
    [...goatBotObservationThreadKeys({ threads, homeWork: links })]
      .filter((value) => threads.some((t) => key(t.id, t.environmentId) === value))
      .toSorted();
  expect(visibleKeys(refs)).toEqual(
    [key("worker"), key("coding"), key("remote-coding", REMOTE)].toSorted(),
  );
  expect(visibleKeys(refs.filter((ref) => ref.threadId !== "remote-coding"))).toEqual(
    [key("worker"), key("coding")].toSorted(),
  );
});

it("does not carry the bot observation closure across a delegated child's top-level launch", () => {
  const threads = [
    thread(SESSION),
    thread("delegate", { launchedBy: SESSION, via: "delegate_task" }),
    thread("launch", { launchedBy: "delegate", via: "thread_launch" }),
  ];
  expect([...goatBotObservationThreadKeys({ threads, homeWork: [] })]).not.toContain(key("launch"));
  expect([
    ...goatBotObservationThreadKeys({
      threads,
      homeWork: [
        {
          taskId: "task" as never,
          environmentId: HOME,
          threadId: ThreadId.make("launch"),
          kind: "coding",
        },
      ],
    }),
  ]).toContain(key("launch"));
});
