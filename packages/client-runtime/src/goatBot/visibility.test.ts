import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import {
  goatBotObservationThreadKeys,
  type GoatBotKnownWorker,
  type GoatBotVisibilityThread,
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
            },
          },
  };
}

const worker = (
  id: string,
  kind: GoatBotKnownWorker["kind"],
  environmentId = HOME,
): GoatBotKnownWorker => ({ environmentId, threadId: ThreadId.make(id), kind });

const key = (id: string, environmentId = HOME) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));

const hidden = (
  threads: ReadonlyArray<GoatBotVisibilityThread>,
  knownWorkers?: ReadonlyArray<GoatBotKnownWorker>,
) =>
  [...goatBotObservationThreadKeys({ threads, ...(knownWorkers ? { knownWorkers } : {}) })]
    .filter((entry) => threads.some((t) => key(t.id, t.environmentId) === entry))
    .toSorted();

const SESSION = "goat-bot-session:conversation";

describe("goatBotObservationThreadKeys", () => {
  it("hides session threads by their id prefix only", () => {
    expect(hidden([thread(SESSION), thread("not-goat-bot-session:x")])).toEqual([key(SESSION)]);
  });

  it("hides a known turn worker in its own environment, and only that one", () => {
    const threads = [
      thread("channel-worker:a", { environmentId: REMOTE }),
      thread("channel-worker:a"),
    ];
    expect(hidden(threads, [worker("channel-worker:a", "turn", REMOTE)])).toEqual([
      key("channel-worker:a", REMOTE),
    ]);
  });

  it("keeps a worker visible when its task is not held, whatever its id says", () => {
    expect(hidden([thread("channel-worker:legacy")])).toEqual([]);
  });

  it("keeps work-kind and pre-turn workers visible, also in the bot's own workspace", () => {
    const threads = [thread("channel-worker:work"), thread("channel-worker:old")];
    const workers = [
      worker("channel-worker:work", "work"),
      worker("channel-worker:old", undefined),
    ];
    expect(hidden(threads, workers)).toEqual([]);
  });

  it("hides subagents below a session and below a known turn worker", () => {
    const threads = [
      thread(SESSION),
      thread("observer", { subagentOf: SESSION }),
      thread("nested", { subagentOf: "observer" }),
      thread("channel-worker:turn"),
      thread("turn-child", { subagentOf: "channel-worker:turn" }),
    ];
    expect(hidden(threads, [worker("channel-worker:turn", "turn")])).toEqual(
      [
        key(SESSION),
        key("observer"),
        key("nested"),
        key("channel-worker:turn"),
        key("turn-child"),
      ].toSorted(),
    );
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
      thread("ssh-work", { launchedBy: SESSION, via: "ssh_thread_launch" }),
      thread("worktree-task", { launchedBy: "worktree", via: "delegate_task" }),
      thread("worktree-subagent", { subagentOf: "worktree" }),
    ];
    expect(hidden(threads)).toEqual([key(SESSION)]);
  });

  it("stops at a thread the user promoted to top level", () => {
    const threads = [
      thread(SESSION),
      thread("promoted", { launchedBy: SESSION, promoted: true }),
      thread("promoted-task", { launchedBy: "promoted", via: "delegate_task" }),
    ];
    expect(hidden(threads)).toEqual([key(SESSION)]);
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
