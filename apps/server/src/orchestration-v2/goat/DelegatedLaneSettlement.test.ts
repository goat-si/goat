import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as GitManager from "../../git/GitManager.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ThreadSettlementService from "../ThreadSettlementService.ts";
import { appThread } from "../ThreadSettlementService.admission-test-cases.ts";
import { shell, type SettlementShell } from "../ThreadSettlementService.testFixtures.ts";

const NOW = "2026-11-07T12:00:00.000Z";
const parentId = ThreadId.make("parent");
const childId = ThreadId.make("child");
const taskId = NodeId.make("task:child");
const latestRun = RunId.make("run:child:2");
const earlierRun = RunId.make("run:child:1");
const completedAt = DateTime.makeUnsafe("2026-11-07T11:00:00.000Z");
const updatedAt = DateTime.makeUnsafe("2026-11-07T11:00:01.000Z");

const child = (overrides: Partial<SettlementShell> = {}) =>
  shell({
    id: childId,
    projectId: ProjectId.make("project"),
    lineage: { rootThreadId: parentId, parentThreadId: parentId, relationshipToParent: "subagent" },
    forkedFrom: { type: "node", nodeId: taskId },
    creationSource: "mcp",
    status: "completed",
    latestRunId: latestRun,
    latestRunCompletedAt: completedAt,
    updatedAt,
    ...overrides,
  });

interface Scenario {
  readonly lane: SettlementShell;
  readonly resultPending?: boolean;
  readonly resultRunId?: RunId | null;
  readonly queued?: boolean;
  readonly appOwned?: boolean;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly threads?: ReadonlyArray<OrchestrationV2AppThread>;
}

// The real settlement sweep over one candidate; stores answer only what the child rule reads.
const sweep = Effect.fn("sweep")(function* (
  scenario: Scenario,
  after?: (
    publish: (event: OrchestrationV2DomainEvent) => Effect.Effect<boolean>,
    setResultRun: (runId: RunId) => Effect.Effect<void>,
    scripts: Queue.Queue<ThreadId>,
  ) => Effect.Effect<void>,
) {
  const scripts = yield* Queue.unbounded<ThreadId>();
  const threads = scenario.threads ?? [];
  yield* TestClock.setTime(Date.parse(NOW));
  const activation = yield* Deferred.make<void>();
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const resultRun = yield* Ref.make(
    scenario.resultRunId === undefined ? latestRun : scenario.resultRunId,
  );
  const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const settingsChanges = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
  const merges = yield* PubSub.unbounded<PullRequestService.PullRequestMergeEvent>();
  const records = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const runId = yield* Ref.get(resultRun);
      return threadId === childId
        ? { runs: scenario.queued ? [{ id: RunId.make("run:child:3"), status: "queued" }] : [] }
        : {
            subagents: [
              {
                id: taskId,
                origin: scenario.appOwned === false ? "native" : "app_owned",
                childThreadId: childId,
              },
            ],
            contextTransfers:
              runId === null
                ? []
                : [
                    {
                      type: "subagent_result",
                      sourceThreadId: childId,
                      targetThreadId: parentId,
                      sourcePoint: { threadId: childId, runId },
                    },
                  ],
          };
    });
  const layer = ThreadSettlementService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getSettlementCandidates: () => Effect.succeed([scenario.lane]),
          getThreadRecords: (threadId) =>
            records(threadId).pipe(Effect.map((value) => value as never)),
          getThread: (threadId) =>
            Effect.succeed(threads.find((thread) => thread.id === threadId)!),
          getThreadWorktreePaths: () =>
            Effect.succeed(
              threads.flatMap((thread) =>
                thread.worktreePath === null
                  ? []
                  : [{ threadId: thread.id, worktreePath: thread.worktreePath }],
              ),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromPubSub(events),
          delegatedTaskResultPending: () => Effect.succeed(scenario.resultPending === true),
          dispatch: (command) =>
            Ref.update(commands, (recorded) => [...recorded, command]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            ),
        }),
        Layer.mock(TerminalManager.TerminalManager)({ closeIdle: () => Effect.void }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: (input) =>
            Queue.offer(scripts, ThreadId.make(input.threadId)).pipe(
              Effect.as({ status: "no-script" } as const),
            ),
        }),
        Layer.mock(GitManager.GitManager)({}),
        Layer.mock(PullRequestService.PullRequestService)({
          subscribeMerges: PubSub.subscribe(merges).pipe(Effect.map(Stream.fromSubscription)),
        }),
        ServerSettings.layerTest(scenario.settings),
        Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size).fill(1),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
      ),
    ),
  );
  void settingsChanges;
  return yield* Effect.gen(function* () {
    const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
    yield* service.start();
    yield* Deferred.succeed(activation, undefined);
    yield* TestClock.adjust(0);
    yield* service.drain;
    if (after !== undefined) {
      yield* after(
        (event) => PubSub.publish(events, event),
        (runId) => Ref.set(resultRun, runId),
        scripts,
      );
      yield* TestClock.adjust(0);
      yield* service.drain;
    }
    return yield* Ref.get(commands);
  }).pipe(Effect.provide(layer));
});

const settled = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.auto-settle"
      ? [
          {
            threadId: command.threadId,
            snapshotAt: command.snapshotAt,
            settledAt: command.settledAt,
          },
        ]
      : [],
  );

it.effect("a task lane whose latest result reached its parent settles at its completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      assert.deepEqual(settled(yield* sweep({ lane: child() })), [
        { threadId: childId, snapshotAt: updatedAt, settledAt: completedAt },
      ]);
    }),
  ),
);

it.effect("a task lane stays open while its latest result has not reached the parent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      assert.deepEqual(settled(yield* sweep({ lane: child(), resultPending: true })), []);
      assert.deepEqual(settled(yield* sweep({ lane: child(), resultRunId: earlierRun })), []);
      assert.deepEqual(settled(yield* sweep({ lane: child(), resultRunId: null })), []);
      assert.deepEqual(settled(yield* sweep({ lane: child(), queued: true })), []);
    }),
  ),
);

it.effect("only finished GOAT task lanes settle this way", () =>
  Effect.scoped(
    Effect.gen(function* () {
      assert.deepEqual(settled(yield* sweep({ lane: child({ status: "failed" }) })), []);
      assert.deepEqual(settled(yield* sweep({ lane: child(), appOwned: false })), []);
      assert.deepEqual(settled(yield* sweep({ lane: child({ forkedFrom: null }) })), []);
      const topLevel = child({
        lineage: { rootThreadId: childId, parentThreadId: null, relationshipToParent: null },
      });
      assert.deepEqual(settled(yield* sweep({ lane: topLevel })), []);
    }),
  ),
);

it.effect("the parent's later result for the lane's latest run settles it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commands = yield* sweep(
        { lane: child(), resultRunId: earlierRun },
        (publish, setResultRun) =>
          Effect.gen(function* () {
            yield* setResultRun(latestRun);
            yield* publish({
              type: "context-transfer.created",
              threadId: parentId,
              payload: {
                type: "subagent_result",
                sourceThreadId: childId,
                targetThreadId: parentId,
              },
            } as never);
          }),
      );
      assert.deepEqual(
        settled(commands).map((command) => command.threadId),
        [childId],
      );
    }),
  ),
);

it.effect("a lane keeps its project's opt-out and its pull request rules", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const optedOut = {
        projectSettingsOverrides: {
          project: { sidebarAutoSettleOnMerge: false, sidebarAutoSettleAfterDays: null },
        },
      };
      assert.deepEqual(settled(yield* sweep({ lane: child(), settings: optedOut })), []);
      const withPullRequest = child({
        linkedPullRequest: {
          projectId: ProjectId.make("project"),
          repository: "o/r",
          number: 7,
          url: "https://example.test/o/r/pull/7",
        },
      });
      assert.deepEqual(settled(yield* sweep({ lane: withPullRequest })), []);
    }),
  ),
);

it.effect("a settled lane runs no settle script in a checkout an unsettled thread still uses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lane = appThread(childId, "settled", "/worktrees/shared");
      const parent = appThread(parentId, null, "/worktrees/shared");
      const own = appThread("own-worktree", "settled", "/worktrees/own");
      const settledEvent = (settledThread: OrchestrationV2AppThread) =>
        ({
          type: "thread.settled",
          threadId: settledThread.id,
          payload: settledThread,
        }) as never;
      yield* sweep(
        { lane: child({ status: "failed" }), threads: [lane, parent, own] },
        (publish, _setResultRun, scripts) =>
          Effect.gen(function* () {
            yield* publish(settledEvent(lane));
            yield* publish(settledEvent(own));
            // Events are handled in order, so the second script proves the first event is done.
            assert.strictEqual(yield* Queue.take(scripts), own.id);
            assert.isTrue(Option.isNone(yield* Queue.poll(scripts)));
          }),
      );
    }),
  ),
);
