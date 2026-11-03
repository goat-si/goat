import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadShellSnapshot,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { buildActiveShellSnapshot, shellSnapshotForSubscriber } from "./ShellStream.ts";

const layerTest = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const now = DateTime.makeUnsafe("2026-11-03T12:00:00.000Z");
const projectId = ProjectId.make("project:shell-equivalence");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const id = (name: string) => ThreadId.make(`thread:shell-equivalence:${name}`);
const runId = (name: string) => RunId.make(`run:shell-equivalence:${name}`);

const createThread = Effect.fn("shellEquivalence.createThread")(function* (input: {
  readonly name: string;
  readonly parent?: string;
  readonly root?: string;
  readonly fork?: string;
  readonly launcher?: string;
  readonly archived?: boolean;
  readonly settledAt?: DateTime.Utc;
  readonly watch?: boolean;
  readonly unwatchedPr?: boolean;
}) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = id(input.name);
  yield* store.apply({
    id: EventId.make(`event:shell-equivalence:thread:${input.name}`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: input.parent === undefined ? "web" : "mcp",
      id: threadId,
      projectId,
      title: input.name,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: input.parent === undefined ? null : id(input.parent),
        relationshipToParent: input.parent === undefined ? null : "subagent",
        rootThreadId: id(input.root ?? input.name),
      },
      forkedFrom:
        input.fork === undefined
          ? null
          : { type: "run", threadId: id(input.fork), runId: runId(input.fork) },
      ...(input.launcher === undefined
        ? {}
        : {
            launchedBy: {
              kind: "launch" as const,
              threadId: id(input.launcher),
              environmentId: null,
              environmentLabel: null,
              threadTitle: null,
              via: "thread_launch" as const,
            },
          }),
      ...(input.watch === true || input.unwatchedPr === true
        ? {
            pullRequests: [
              {
                host: "github.com",
                repository: "goat-si/goat",
                number: 7,
                url: "https://github.com/goat-si/goat/pull/7",
                source: "agent" as const,
                linkedAt: DateTime.formatIso(now),
                snapshot: null,
                stack: null,
                ...(input.watch === true
                  ? {
                      watch: {
                        startedAt: DateTime.formatIso(now),
                        headSha: null,
                        failedChecks: [],
                        passed: false,
                        passedChecks: [],
                        remarksThrough: DateTime.formatIso(now),
                        remarkIds: [],
                        conflicting: false,
                        wakes: 0,
                      },
                    }
                  : {}),
              },
            ],
          }
        : {}),
      createdAt: now,
      updatedAt: now,
      archivedAt: input.archived === true ? now : null,
      settledOverride: input.settledAt === undefined ? null : "settled",
      settledAt: input.settledAt ?? null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
});

const addProviderThread = Effect.fn("shellEquivalence.addProviderThread")(function* (
  name: string,
  hasTask: boolean,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = id(name);
  yield* store.apply({
    id: EventId.make(`event:shell-equivalence:provider:${name}`),
    type: "provider-thread.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: ProviderThreadId.make(`provider:shell-equivalence:${name}`),
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      pendingBackgroundTasks: hasTask ? [{ taskId: "native-task", kind: "subagent" }] : [],
    },
  });
});

const createRun = Effect.fn("shellEquivalence.createRun")(function* (
  name: string,
  status: "running" | "completed" = "completed",
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = id(name);
  const currentRunId = runId(name);
  yield* store.apply({
    id: EventId.make(`event:shell-equivalence:run:${name}`),
    type: "run.created",
    threadId,
    runId: currentRunId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: {
      id: currentRunId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:shell-equivalence:${name}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
});

const addRunItem = Effect.fn("shellEquivalence.addRunItem")(function* (
  name: string,
  status: "running" | "completed" = "completed",
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = id(name);
  const currentRunId = runId(name);
  const itemId = TurnItemId.make(`item:shell-equivalence:${name}`);
  yield* store.apply({
    id: EventId.make(`event:shell-equivalence:item:${name}`),
    type: "turn-item.updated",
    threadId,
    runId: currentRunId,
    driver,
    occurredAt: now,
    payload: {
      id: itemId,
      threadId,
      runId: currentRunId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status,
      title: null,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      updatedAt: now,
      type: "command_execution",
      input: "fixture",
      output: "fixture output",
      exitCode: 0,
    },
  });
});

const addRequest = Effect.fn("shellEquivalence.addRequest")(function* (name: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const nodeId = NodeId.make(`node:shell-equivalence:${name}`);
  yield* store.apply({
    id: EventId.make(`event:shell-equivalence:request:${name}`),
    type: "runtime-request.updated",
    threadId: id(name),
    nodeId,
    driver,
    occurredAt: now,
    payload: {
      id: RuntimeRequestId.make(`request:shell-equivalence:${name}`),
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: now,
      resolvedAt: null,
    },
  });
});

const cases = [
  "nested idle subagents retain their parent",
  "running and request-bearing subagents remain visible",
  "a pull request watch keeps a settled or runless subagent visible",
  "active subagent fork sources and two-level forks preserve visible counts",
  "a local launcher and its subagent parent chain remain visible",
  "older settled filtering preserves the ancestor of a kept subagent",
  "an archived fork source does not add its active parent to the subagent index",
  "an idle subagent with an empty provider roster is omitted",
  "a settled subagent with provider background work remains visible",
  "an idle subagent with an unwatched pull request is omitted",
  "a settled subagent with a running background command remains visible",
] as const;

it.effect.each(cases)(
  "opt-in shell subscribers get the same rows and subagent filter whether or not idle subagents are decoded: %s",
  (scenario) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* createThread({ name: "root" });
      if (scenario === cases[0]) {
        yield* createThread({ name: "parent", parent: "root", root: "root" });
        yield* createThread({ name: "child", parent: "parent", root: "root" });
      } else if (scenario === cases[1]) {
        yield* createThread({ name: "running", parent: "root", root: "root" });
        yield* createRun("running", "running");
        yield* createThread({ name: "request", parent: "root", root: "root" });
        yield* addRequest("request");
      } else if (scenario === cases[2]) {
        yield* createThread({ name: "runless-watch", parent: "root", root: "root", watch: true });
        yield* createThread({ name: "settled-watch", parent: "root", root: "root", watch: true });
        yield* createRun("settled-watch");
      } else if (scenario === cases[3]) {
        yield* createThread({ name: "source", parent: "root", root: "root" });
        yield* createRun("source");
        yield* addRunItem("source");
        yield* createThread({ name: "middle", parent: "root", root: "root", fork: "source" });
        yield* createRun("middle");
        yield* addRunItem("middle");
        yield* createThread({ name: "target", fork: "middle" });
      } else if (scenario === cases[4]) {
        yield* createThread({ name: "parent", parent: "root", root: "root" });
        yield* createThread({ name: "launcher", parent: "parent", root: "root" });
        yield* createThread({ name: "launched", launcher: "launcher" });
      } else if (scenario === cases[5]) {
        yield* createThread({
          name: "older-parent",
          settledAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
        });
        yield* createThread({ name: "live-child", parent: "older-parent", root: "older-parent" });
        yield* createRun("live-child", "running");
        yield* createThread({
          name: "older-removed",
          settledAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
        });
        for (let n = 0; n < 26; n++) {
          yield* createThread({
            name: `recent-${n}`,
            settledAt: DateTime.makeUnsafe(Date.UTC(2026, 9, n + 1)),
          });
        }
      } else if (scenario === cases[6]) {
        yield* createThread({ name: "parent", parent: "root", root: "root" });
        yield* createThread({
          name: "archived-source",
          parent: "parent",
          root: "root",
          archived: true,
        });
        yield* createRun("archived-source");
        yield* addRunItem("archived-source");
        yield* createThread({ name: "target", fork: "archived-source" });
      } else if (scenario === cases[7] || scenario === cases[8]) {
        yield* createThread({ name: "provider-child", parent: "root", root: "root" });
        yield* createRun("provider-child");
        yield* addProviderThread("provider-child", scenario === cases[8]);
      } else if (scenario === cases[9]) {
        yield* createThread({ name: "unwatched", parent: "root", root: "root", unwatchedPr: true });
      } else {
        yield* createThread({ name: "background", parent: "root", root: "root" });
        yield* createRun("background");
        yield* addRunItem("background", "running");
      }

      const full = yield* store.getShellSnapshot({ location: "active" });
      const optimizedOptions = { location: "active" as const, omitIdleSubagents: true };
      const optimized: ProjectionStore.ShellSnapshotRead =
        yield* store.getShellSnapshot(optimizedOptions);
      const shellIndex: ProjectionStore.ShellSnapshotIndex | undefined = optimized.shellIndex;
      const options = { omitIdleSubagents: true, omitOlderSettled: scenario === cases[5], now };
      const base = (threads: OrchestrationV2ThreadShellSnapshot) =>
        buildActiveShellSnapshot({
          projects: [],
          threads,
          snapshotSequence: threads.snapshotSequence,
        });
      for (const omitOlderSettled of [false, true]) {
        const subscriberOptions = { omitIdleSubagents: true, omitOlderSettled, now };
        const expected = shellSnapshotForSubscriber(base(full), subscriberOptions);
        const actual = shellSnapshotForSubscriber(base(optimized), subscriberOptions, shellIndex);
        assert.deepEqual(actual.snapshot, expected.snapshot);
        assert.deepEqual(actual.subagentThreadIds, expected.subagentThreadIds);
      }
      const expected = shellSnapshotForSubscriber(base(full), options);

      const visible = new Set(expected.snapshot.threads.map((thread) => thread.id));
      if (scenario === cases[0]) {
        assert.isTrue(visible.has(id("parent")));
        assert.isFalse(visible.has(id("child")));
        assert.isTrue(expected.subagentThreadIds.has(id("child")));
      } else if (scenario === cases[1]) {
        assert.isTrue(visible.has(id("running")));
        assert.isTrue(visible.has(id("request")));
      } else if (scenario === cases[2]) {
        assert.isTrue(visible.has(id("runless-watch")));
        assert.isTrue(visible.has(id("settled-watch")));
      } else if (scenario === cases[3]) {
        assert.equal(
          expected.snapshot.threads.find((thread) => thread.id === id("target"))?.visibleItemCount,
          4,
        );
        assert.isFalse(visible.has(id("source")));
        assert.isFalse(visible.has(id("middle")));
      } else if (scenario === cases[4]) {
        assert.isTrue(visible.has(id("launcher")));
        assert.isTrue(visible.has(id("parent")));
      } else if (scenario === cases[5]) {
        assert.isTrue(visible.has(id("older-parent")));
        assert.isFalse(visible.has(id("older-removed")));
      } else if (scenario === cases[6]) {
        assert.equal(
          expected.snapshot.threads.find((thread) => thread.id === id("target"))?.visibleItemCount,
          2,
        );
        assert.isFalse(visible.has(id("parent")));
        assert.isFalse(expected.subagentThreadIds.has(id("archived-source")));
      } else if (scenario === cases[7] || scenario === cases[8]) {
        assert.equal(visible.has(id("provider-child")), scenario === cases[8]);
        assert.isTrue(expected.subagentThreadIds.has(id("provider-child")));
      } else if (scenario === cases[9]) {
        assert.isFalse(visible.has(id("unwatched")));
        assert.isTrue(expected.subagentThreadIds.has(id("unwatched")));
      } else {
        assert.isTrue(visible.has(id("background")));
      }
    }).pipe(Effect.provide(layerTest)),
);
