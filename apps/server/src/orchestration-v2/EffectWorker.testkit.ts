import { assert } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ThreadId,
  RunId,
  CheckpointScopeId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
const heldTitleLayer = Effect.fn("EffectWorker.test.heldTitleLayer")(function* (input: {
  readonly target: ThreadId;
  readonly requestId: CommandId;
  readonly messageId: MessageId;
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  readonly stopped: Deferred.Deferred<void>;
  readonly commands: OrchestrationV2ServerCommand[];
  readonly cleanupStarted?: Deferred.Deferred<void>;
  readonly cleanupRelease?: Deferred.Deferred<void>;
}) {
  const { target, requestId, messageId, entered, release, stopped, commands } = input;
  const projection = idleThreadProjection(liveThreadShell(target));
  const now = yield* DateTime.now;
  const titleLayer = ThreadTitleRegenerationService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              ...projection,
              thread: {
                ...projection.thread,
                titleRegeneration: { requestId, startedAt: now },
              },
              messages: [
                {
                  id: messageId,
                  threadId: target,
                  runId: null,
                  nodeId: null,
                  role: "user" as const,
                  createdBy: "user" as const,
                  creationSource: "web" as const,
                  text: "Synthetic task",
                  attachments: [],
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            }),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
              projectId: ProjectId.make("project:mcp-test"),
              title: "Synthetic project",
              workspaceRoot: "/synthetic",
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(TextGeneration.TextGeneration)({
          generateThreadTitle: () =>
            Effect.acquireUseRelease(
              Deferred.succeed(entered, undefined),
              () => Deferred.await(release).pipe(Effect.as({ title: "Late title" })),
              () =>
                Effect.gen(function* () {
                  if (input.cleanupStarted !== undefined)
                    yield* Deferred.succeed(input.cleanupStarted, undefined);
                  if (input.cleanupRelease !== undefined)
                    yield* Deferred.await(input.cleanupRelease);
                  yield* Deferred.succeed(stopped, undefined);
                }),
            ),
        }),
      ),
    ),
  );
  return titleLayer;
});

export const heldTitleDeadline = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const stopped = yield* Deferred.make<void>();
  const cleanupStarted = yield* Deferred.make<void>();
  const cleanupRelease = yield* Deferred.make<void>();
  const completed = yield* Deferred.make<void>();
  const commands: OrchestrationV2ServerCommand[] = [];
  const target = ThreadId.make("thread:title-budget");
  const requestId = CommandId.make("command:title-budget");
  const messageId = MessageId.make("message:title-budget");
  const titleLayer = yield* heldTitleLayer({
    target,
    requestId,
    messageId,
    entered,
    release,
    stopped,
    commands,
    cleanupStarted,
    cleanupRelease,
  });
  yield* Effect.gen(function* () {
    const titles = yield* ThreadTitleRegenerationService.ThreadTitleRegenerationService;
    const execution = yield* titles
      .execute({ threadId: target, requestId, kind: { type: "initial", messageId } })
      .pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
        Effect.forkScoped,
      );
    yield* Deferred.await(entered);
    yield* TestClock.adjust("3 minutes");
    assert.isTrue(yield* Deferred.isDone(cleanupStarted));
    assert.isFalse(yield* Deferred.isDone(completed));
    assert.isFalse(yield* Deferred.isDone(stopped));
    assert.deepEqual(commands, []);
    yield* Deferred.succeed(cleanupRelease, undefined);
    yield* Fiber.join(execution);
    assert.isTrue(yield* Deferred.isDone(completed));
    assert.isTrue(yield* Deferred.isDone(stopped));
    assert.deepEqual(commands, [
      {
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make(`${requestId}:title-complete`),
        threadId: target,
        requestId,
      },
    ]);
    yield* Fiber.join(execution);
  }).pipe(
    Effect.ensuring(Deferred.succeed(cleanupRelease, undefined)),
    Effect.ensuring(Deferred.succeed(release, undefined)),
    Effect.provide(titleLayer),
  );
}).pipe(Effect.scoped);

export const reservedCleanup = Effect.gen(function* () {
  const entered = yield* Queue.unbounded<string>();
  const release = yield* Deferred.make<void>();
  const cleanupDone = yield* Deferred.make<void>();
  const ids = ["held:1", "held:2", "held:3", "held:4"];
  yield* Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    yield* outbox.enqueue(
      ids.map((id) => ({
        id,
        commandId: CommandId.make(`command:${id}`),
        threadId: ThreadId.make(`thread:${id}`),
        request: {
          type: "checkpoint.capture" as const,
          runId: RunId.make(`run:${id}`),
          scopeId: CheckpointScopeId.make(`scope:${id}`),
        },
      })),
    );
    const workerLayer = EffectWorker.layerWithOptions({ maxAttempts: 1 }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
          Layer.mock(EffectWorker.OrchestrationEffectExecutorV2)({
            execute: (effect) =>
              effect.id === "cleanup:5"
                ? Deferred.succeed(cleanupDone, undefined).pipe(Effect.asVoid)
                : Queue.offer(entered, effect.id).pipe(Effect.andThen(Deferred.await(release))),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      yield* EffectWorker.runDaemonWithOptions({ concurrency: 4 }).pipe(Effect.forkScoped);
      assert.sameMembers(yield* Effect.forEach(ids, () => Queue.take(entered)), ids);
      yield* outbox.enqueue([
        {
          id: "cleanup:5",
          commandId: CommandId.make("command:cleanup:5"),
          threadId: ThreadId.make("thread:independent-cleanup"),
          request: { type: "terminal.cleanup" },
        },
      ]);
      yield* outbox.notifyAvailable(6);
      yield* TestClock.adjust("1 second");
      assert.isTrue(yield* Deferred.isDone(cleanupDone));
      yield* outbox.awaitSettled("cleanup:5");
      assert.equal(Option.getOrThrow(yield* outbox.get("cleanup:5")).status, "succeeded");
      for (const id of ids) {
        assert.equal(Option.getOrThrow(yield* outbox.get(id)).status, "running");
      }
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)), Effect.provide(workerLayer));
  }).pipe(
    Effect.provide(EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  );
}).pipe(Effect.scoped);

export const cancellationFence = (interruptOwner = false) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cleaning = yield* Deferred.make<void>();
    const releaseCleanup = yield* Deferred.make<void>();
    const operations: string[] = [];
    const target = ThreadId.make("thread:late-native-cleanup");
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const pending = (id: string): EffectOutbox.PendingOrchestrationEffectV2 => ({
        id,
        commandId: CommandId.make(`command:${id}`),
        threadId: target,
        request: { type: "terminal.cleanup" },
      });
      yield* outbox.enqueue([pending("native:first")]);
      const workerLayer = EffectWorker.layerWithOptions({ maxAttempts: 1 }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
            Layer.mock(EffectWorker.OrchestrationEffectExecutorV2)({
              execute: (effect) =>
                effect.id === "native:first"
                  ? Effect.acquireUseRelease(
                      Effect.sync(() => operations.push("first:native")),
                      () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                      () =>
                        Deferred.succeed(cleaning, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseCleanup)),
                          Effect.andThen(Effect.sync(() => operations.push("first:stopped"))),
                        ),
                    )
                  : Effect.sync(() => {
                      operations.push("second:native");
                    }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const first = yield* worker.runOnce.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const cancelled = yield* outbox.cancelUnsettled({
          threadId: target,
          effectTypes: ["terminal.cleanup"],
          reason: "Synthetic cancellation while native cleanup is held.",
        });
        assert.deepEqual(cancelled, ["native:first"]);
        yield* outbox.signalCancellations(cancelled);
        yield* Deferred.await(cleaning);
        const stopping = interruptOwner
          ? yield* Fiber.interrupt(first).pipe(Effect.forkScoped)
          : undefined;
        yield* outbox.enqueue([
          pending("native:second"),
          {
            ...pending("native:unrelated"),
            threadId: ThreadId.make("thread:independent-cancel"),
          },
        ]);
        yield* TestClock.adjust("1 minute");
        assert.isFalse(yield* worker.runOnce);
        assert.deepEqual(operations, ["first:native"]);
        assert.equal(Option.getOrThrow(yield* outbox.get("native:second")).status, "pending");
        yield* Deferred.succeed(releaseCleanup, undefined);
        if (stopping === undefined) yield* Fiber.join(first);
        else yield* Fiber.join(stopping);
        assert.isTrue(yield* worker.runOnce);
        assert.deepEqual(operations, ["first:native", "first:stopped", "second:native"]);
        assert.isTrue(yield* worker.runOnce);
      }).pipe(
        Effect.ensuring(Deferred.succeed(releaseCleanup, undefined)),
        Effect.provide(workerLayer),
      );
    }).pipe(
      Effect.provide(EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    );
  }).pipe(Effect.scoped);

export const mockExecution = () => ({
  begin: () => Effect.succeedSome("synthetic"),
  warnSlowCleanup: () => Effect.void,
  retireJoined: () => Effect.void,
  retireAdmission: () => Effect.void,
  admitClaim: () => Effect.void,
  setGeneralCapacity: () => Effect.void,
  snapshot: Effect.succeed({
    fullLanes: [],
    titleThreads: [],
    mainThreads: [],
    stoppingThreads: [],
  }),
});

export const idleEffectWorker = () =>
  EffectWorker.OrchestrationEffectWorkerV2.of({
    configureConcurrency: () => Effect.void,
    awaitWork: Effect.void,
    awaitControlWork: Effect.void,
    awaitCleanupWork: Effect.void,
    runOnce: Effect.succeed(false),
    runRecoveryOnce: Effect.succeed(false),
    runGeneralOnce: Effect.succeed(false),
    runControlOnce: Effect.succeed(false),
    runCleanupOnce: Effect.succeed(false),
    nextClaimableAt: Effect.succeedNone,
    nextGeneralClaimableAt: Effect.succeedNone,
    nextControlClaimableAt: Effect.succeedNone,
    nextCleanupClaimableAt: Effect.succeedNone,
    drain: () => Effect.succeed(0),
  });
