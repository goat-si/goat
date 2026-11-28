import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@goat/client-runtime/state/threads";
import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { makeThreadProjectionFixture } from "../test-fixtures";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createRunningThreadKeepAliveAtom } from "./threads";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

type Status = "running" | "starting" | "preparing" | "queued" | "waiting" | "idle";
type ShellOverrides = Partial<
  Pick<
    OrchestrationV2ThreadShell,
    | "lineage"
    | "archivedAt"
    | "deletedAt"
    | "creationSource"
    | "launchedBy"
    | "lastVisitedAt"
    | "createdAt"
  >
>;
function shell(id: string, status: Status | null, overrides: ShellOverrides = {}) {
  return {
    id: ThreadId.make(id),
    status: status ?? "idle",
    ...overrides,
  } satisfies Pick<OrchestrationV2ThreadShell, "id" | "status"> & ShellOverrides;
}
function detail(id: string, status: Status, overrides: Partial<EnvironmentThreadState> = {}) {
  const projection = makeThreadProjectionFixture();
  const threadId = ThreadId.make(id);
  const thread = {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    runs:
      status === "idle"
        ? []
        : [
            {
              id: RunId.make(`run-${id}`),
              threadId,
              ordinal: 1,
              providerInstanceId: projection.thread.providerInstanceId,
              modelSelection: projection.thread.modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`message-${id}`),
              rootNodeId: null,
              activeAttemptId: null,
              status,
              requestedAt: projection.updatedAt,
              startedAt: null,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          ],
  };
  return AsyncResult.success<EnvironmentThreadState>({
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    status: "live",
    data: Option.some(thread),
    ...overrides,
  });
}

function makeHarness(options?: { readonly maxKeptThreads?: number }) {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const environmentIds = Atom.make<ReadonlyArray<EnvironmentId>>([LOCAL, REMOTE]).pipe(
    Atom.keepAlive,
  );
  const threads = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<ReturnType<typeof shell>>>([]).pipe(Atom.keepAlive),
  );
  const keys = new Set<string>();
  const states = Atom.family((_key: string) =>
    Atom.make<AsyncResult.AsyncResult<EnvironmentThreadState>>(
      AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE),
    ),
  );
  const stateAtom = (environmentId: EnvironmentId, threadId: string) => {
    const key = `${environmentId}:${threadId}`;
    keys.add(key);
    return states(key);
  };
  const keepAlive = createRunningThreadKeepAliveAtom({
    environmentIdsAtom: environmentIds,
    threadsAtom: threads,
    stateAtom,
    ...(options?.maxKeptThreads === undefined ? {} : { maxKeptThreads: options.maxKeptThreads }),
  });
  registry.mount(keepAlive);
  return {
    registry,
    environmentIds,
    threads,
    stateAtom,
    keepAlive,
    openStreams: () => {
      flush();
      return [...keys].filter((key) => registry.getNodes().has(states(key))).toSorted();
    },
  };
}

describe("createRunningThreadKeepAliveAtom", () => {
  it("keeps running threads open across shell updates and thread view visits", () => {
    const h = makeHarness();
    h.registry.set(h.threads(LOCAL), [shell("a", "running"), shell("b", "idle"), shell("c", null)]);
    h.registry.set(h.threads(REMOTE), [shell("d", "starting")]);
    expect(h.openStreams()).toEqual(["local:a", "remote:d"]);

    const live = detail("a", "running");
    h.registry.set(h.stateAtom(LOCAL, "a"), live);
    h.registry.mount(h.stateAtom(LOCAL, "a"))();

    const kept = h.registry.get(h.keepAlive);
    h.registry.set(h.threads(LOCAL), [shell("a", "running"), shell("b", "idle")]);
    expect(h.registry.get(h.keepAlive)).toBe(kept);
    expect(h.openStreams()).toEqual(["local:a", "remote:d"]);
    expect(h.registry.get(h.stateAtom(LOCAL, "a"))).toBe(live);
  });

  it("holds a stopped thread until its own stream is live and shows the stop", () => {
    const h = makeHarness();
    h.registry.set(h.threads(LOCAL), [
      shell("a", "running"),
      shell("b", "running"),
      shell("c", "running"),
    ]);
    h.registry.set(h.stateAtom(LOCAL, "a"), detail("a", "running"));
    h.registry.set(
      h.stateAtom(LOCAL, "c"),
      detail("c", "running", { status: "cached", error: Option.some("Could not sync.") }),
    );

    h.registry.set(h.threads(LOCAL), [shell("a", "idle"), shell("b", "idle"), shell("c", "idle")]);
    expect(h.openStreams()).toEqual(["local:a", "local:b"]);

    h.registry.set(h.stateAtom(LOCAL, "a"), detail("a", "idle"));
    h.registry.set(h.stateAtom(LOCAL, "b"), detail("b", "idle", { status: "synchronizing" }));
    expect(h.openStreams()).toEqual(["local:b"]);
    h.registry.set(h.stateAtom(LOCAL, "b"), detail("b", "idle"));
    expect(h.openStreams()).toEqual([]);
  });

  it("follows environments that connect and go away", () => {
    const h = makeHarness();
    h.registry.set(h.environmentIds, [LOCAL]);
    h.registry.set(h.threads(REMOTE), [shell("d", "running")]);
    expect(h.openStreams()).toEqual([]);

    h.registry.set(h.environmentIds, [LOCAL, REMOTE]);
    expect(h.openStreams()).toEqual(["remote:d"]);

    h.registry.set(h.stateAtom(REMOTE, "d"), detail("d", "running"));
    h.registry.set(h.threads(REMOTE), [shell("d", "idle")]);
    expect(h.openStreams()).toEqual(["remote:d"]);
    h.registry.set(h.environmentIds, [LOCAL]);
    expect(h.openStreams()).toEqual([]);
  });

  it("excludes subagents, mcp, delegated-task, channel-worker, goat-bot, and archived threads", () => {
    const h = makeHarness();
    h.registry.set(h.threads(LOCAL), [
      shell("user-1", "running"),
      shell("sub-1", "running", {
        lineage: {
          parentThreadId: ThreadId.make("user-1"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("user-1"),
        },
      }),
      shell("mcp:worker-1", "running"),
      shell("ordinary-mcp", "running", { creationSource: "mcp" }),
      shell("thread:delegated-task:abc", "running"),
      shell("delegated-by-launcher", "running", {
        launchedBy: {
          kind: "launch",
          via: "delegate_task",
          threadId: ThreadId.make("user-1"),
          environmentId: LOCAL,
          environmentLabel: null,
          threadTitle: null,
        },
      }),
      shell("channel-worker:abc", "running"),
      shell("remote-channel-worker:abc", "running"),
      shell("channel-bot:main", "running"),
      shell("goat-bot-session:abc", "running"),
      shell("archived-1", "running", {
        archivedAt: DateTime.makeUnsafe("2026-11-28T00:00:00.000Z"),
      }),
      shell("deleted-1", "running", {
        deletedAt: DateTime.makeUnsafe("2026-11-28T00:00:00.000Z"),
      }),
    ]);

    expect(h.openStreams()).toEqual(["local:user-1"]);
  });

  it("caps concurrently kept-alive streams and prioritizes recently visited user threads", () => {
    const h = makeHarness({ maxKeptThreads: 2 });
    h.registry.set(h.threads(LOCAL), [
      shell("older-visited", "running", {
        lastVisitedAt: DateTime.makeUnsafe("2026-11-28T01:00:00.000Z"),
        createdAt: DateTime.makeUnsafe("2026-11-28T00:00:00.000Z"),
      }),
      shell("never-visited", "running", {
        createdAt: DateTime.makeUnsafe("2026-11-28T02:00:00.000Z"),
      }),
      shell("newest-visited", "running", {
        lastVisitedAt: DateTime.makeUnsafe("2026-11-28T03:00:00.000Z"),
        createdAt: DateTime.makeUnsafe("2026-11-28T00:00:00.000Z"),
      }),
    ]);
    h.registry.set(h.threads(REMOTE), [
      shell("remote-visited", "running", {
        lastVisitedAt: DateTime.makeUnsafe("2026-11-28T02:30:00.000Z"),
        createdAt: DateTime.makeUnsafe("2026-11-28T00:00:00.000Z"),
      }),
    ]);

    expect(h.openStreams()).toEqual(["local:newest-visited", "remote:remote-visited"]);
  });
});
