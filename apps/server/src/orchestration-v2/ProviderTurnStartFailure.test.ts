import { expect } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CommandId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as CheckpointRollback from "./CheckpointRollbackService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControl from "./ProviderTurnControlService.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ResourceCleanup from "./ResourceCleanupService.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as RuntimeRequest from "./RuntimeRequestService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

effectIt.effect("retains the starting attempt identity when a later projection read fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      historyReadFailureAfterFallback: new Error("database unavailable"),
    });
    const error = yield* harness.start.pipe(Effect.flip);
    expect(error).toMatchObject({
      attemptId: harness.attemptId,
      rootNodeId: harness.projection().runs.at(-1)?.rootNodeId,
    });
  }),
);

effectIt.effect("fails only the starting attempt whose retries are exhausted", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue" });
    const run = harness.projection().runs.at(-1)!;
    yield* Effect.gen(function* () {
      const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
      yield* service.failStartingRun({
        threadId: harness.threadId,
        runId: harness.runId,
        attemptId: harness.attemptId,
        rootNodeId: run.rootNodeId!,
      });
    }).pipe(Effect.provide(harness.layer));
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().attempts[0]?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([{ type: "error", status: "failed" }]);
  }),
);

effectIt.effect("does not fail a replacement attempt after a stale start failure", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue" });
    const projection = harness.projection();
    const run = projection.runs.at(-1)!;
    const replacement = RunAttemptId.make("replacement-start-attempt");
    harness.setProjection({
      ...projection,
      runs: projection.runs.map((candidate) => ({ ...candidate, activeAttemptId: replacement })),
    });
    yield* Effect.gen(function* () {
      const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
      yield* service.failStartingRun({
        threadId: harness.threadId,
        runId: harness.runId,
        attemptId: harness.attemptId,
        rootNodeId: run.rootNodeId!,
      });
    }).pipe(Effect.provide(harness.layer));
    expect(harness.projection().runs.at(-1)).toMatchObject({
      status: "starting",
      activeAttemptId: replacement,
    });
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
  }),
);

const makeWorker = (
  harness: ReturnType<typeof makeLocalCommandHarness>,
  maxAttempts: number,
  control: Partial<ProviderTurnControl.ProviderTurnControlServiceV2["Service"]> = {},
) =>
  Effect.gen(function* () {
    const outboxLayer = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
    const executorLayer = EffectWorker.layerExecutor.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          Layer.mock(ResourceCleanup.ResourceCleanupService)({}),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({}),
          Layer.mock(RunFinalization.RunFinalizationService)({}),
          Layer.mock(ProviderTurnControl.ProviderTurnControlServiceV2)(control),
          Layer.mock(RuntimeRequest.RuntimeRequestServiceV2)({}),
          Layer.mock(ThreadTitleRegeneration.ThreadTitleRegenerationService)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const workerLayer = EffectWorker.layerWithOptions({ maxAttempts }).pipe(
      Layer.provide(executorLayer),
      Layer.provideMerge(outboxLayer),
    );
    const services = yield* Layer.build(workerLayer);
    const outbox = Context.get(services, EffectOutbox.EffectOutboxV2);
    const worker = Context.get(services, EffectWorker.OrchestrationEffectWorkerV2);
    return { outbox, worker };
  });

effectIt.effect("exhausted start failure visibly settles the owned attempt", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      historyReadFailureAfterFallback: new Error("database unavailable"),
    });
    const { outbox, worker } = yield* makeWorker(harness, 1);
    yield* outbox.enqueue([
      {
        id: "effect:exhausted-start",
        commandId: CommandId.make("command:exhausted-start"),
        threadId: harness.threadId,
        request: { type: "provider-turn.start", runId: harness.runId },
      },
    ]);
    expect(yield* worker.runOnce).toBe(true);
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().attempts[0]?.status).toBe("failed");
    expect(Option.getOrThrow(yield* outbox.get("effect:exhausted-start")).status).toBe("failed");
    expect(yield* worker.runOnce).toBe(false);
  }).pipe(Effect.scoped),
);

effectIt.effect("cancelling a start during backoff prevents remaining claims", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      historyReadFailureAfterFallback: new Error("database unavailable"),
    });
    const { outbox, worker } = yield* makeWorker(harness, 3);
    const id = "effect:stop-backoff";
    yield* outbox.enqueue([
      {
        id,
        commandId: CommandId.make("command:stop-backoff"),
        threadId: harness.threadId,
        request: { type: "provider-turn.start", runId: harness.runId },
      },
    ]);
    expect(yield* worker.runOnce).toBe(true);
    expect(Option.getOrThrow(yield* outbox.get(id))).toMatchObject({
      status: "pending",
      attemptCount: 1,
    });
    yield* outbox.cancelUnsettled({
      threadId: harness.threadId,
      effectTypes: ["provider-turn.start"],
      reason: "Stopped",
    });
    yield* TestClock.adjust("1 minute");
    expect(yield* worker.runOnce).toBe(false);
    expect(Option.getOrThrow(yield* outbox.get(id)).status).toBe("cancelled");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

effectIt.effect("start failures exhaust the bounded worker budget and settle once", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      historyReadFailureAfterFallback: new Error("database unavailable"),
    });
    const { outbox, worker } = yield* makeWorker(harness, 3);
    const id = "effect:bounded-start";
    yield* outbox.enqueue([
      {
        id,
        commandId: CommandId.make("command:bounded-start"),
        threadId: harness.threadId,
        request: { type: "provider-turn.start", runId: harness.runId },
      },
    ]);
    expect(yield* worker.runOnce).toBe(true);
    expect(Option.getOrThrow(yield* outbox.get(id))).toMatchObject({
      status: "pending",
      attemptCount: 1,
    });
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    yield* TestClock.adjust("100 millis");
    expect(yield* worker.runOnce).toBe(true);
    expect(Option.getOrThrow(yield* outbox.get(id))).toMatchObject({
      status: "pending",
      attemptCount: 2,
    });
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    yield* TestClock.adjust("200 millis");
    expect(yield* worker.runOnce).toBe(true);
    expect(Option.getOrThrow(yield* outbox.get(id))).toMatchObject({
      status: "failed",
      attemptCount: 3,
    });
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    yield* TestClock.adjust("1 minute");
    expect(yield* worker.runOnce).toBe(false);
  }).pipe(Effect.scoped),
);

effectIt.effect("a failed final settlement leaves a durable failed effect and a starting run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      historyReadFailureAfterFallback: new Error("read failed"),
      writeFailure: new Error("write failed"),
    });
    const initial = harness.projection();
    const image = {
      type: "image" as const,
      id: "recovery-image",
      name: "recovery.png",
      mimeType: "image/png",
      sizeBytes: 100,
    };
    const originalMessages = initial.messages.map((message) => ({
      ...message,
      attachments: [image],
    }));
    harness.setProjection({ ...initial, messages: originalMessages });
    const { outbox, worker } = yield* makeWorker(harness, 1);
    const id = "effect:failed-settlement";
    yield* outbox.enqueue([
      {
        id,
        commandId: CommandId.make("command:failed-settlement"),
        threadId: harness.threadId,
        request: { type: "provider-turn.start", runId: harness.runId },
      },
    ]);
    expect(yield* worker.runOnce).toBe(true);
    expect(Option.getOrThrow(yield* outbox.get(id))).toMatchObject({
      status: "failed",
      attemptCount: 1,
    });
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(yield* worker.runOnce).toBe(false);
    const recoveryLayer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([harness.threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(harness.projection()),
            getThreadRecords: harness.getThreadRecords,
            getMessagesById: (_threadId, ids) =>
              Effect.succeed(
                new Map(
                  harness
                    .projection()
                    .messages.filter((message) => ids.includes(message.id))
                    .map((message) => [message.id, message]),
                ),
              ),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: ({ events }) =>
              Effect.sync(() => {
                let projection = harness.projection();
                for (const event of events)
                  projection = ProjectionStore.applyToProjection(projection, event);
                harness.setProjection(projection);
                return { committed: true, cancelledEffectCount: 0 } as never;
              }),
          }),
          IdAllocator.layer,
          Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    }).pipe(Effect.provide(recoveryLayer));
    expect(harness.projection().runs.at(-1)).toMatchObject({ status: "queued", queueHeld: true });
    expect(harness.projection().messages).toEqual(originalMessages);
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(yield* worker.runOnce).toBe(false);
  }).pipe(Effect.scoped),
);

effectIt.effect("exhausted restart cleanup fails only its captured starting attempt", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue" });
    const providerTurnId = ProviderTurnId.make("restart-old-turn");
    const { outbox, worker } = yield* makeWorker(harness, 1, {
      interruptAndAwaitTerminal: () =>
        Effect.fail(
          new ProviderTurnControl.ProviderTurnControlError({
            threadId: harness.threadId,
            operation: "restart",
            providerTurnId,
            cause: "interrupt failed",
          }),
        ),
    });
    const id = "effect:restart-cleanup-failure";
    yield* outbox.enqueue([
      {
        id,
        commandId: CommandId.make("command:restart-cleanup-failure"),
        threadId: harness.threadId,
        request: {
          type: "provider-turn.restart",
          runId: harness.runId,
          providerSessionId: ProviderSessionId.make("old-session"),
          providerThreadId: ProviderThreadId.make("old-thread"),
          providerTurnId,
          interruptedAttemptId: RunAttemptId.make("old-attempt"),
        },
      },
    ]);
    expect(yield* worker.runOnce).toBe(true);
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().attempts[0]?.status).toBe("failed");
    expect(Option.getOrThrow(yield* outbox.get(id)).status).toBe("failed");
  }).pipe(Effect.scoped),
);

effectIt.effect.each(["stop", "replacement"] as const)(
  "restart cleanup never overwrites %s that wins the race",
  (change) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "Continue" });
      const providerTurnId = ProviderTurnId.make("restart-race-turn");
      const replacement = RunAttemptId.make("restart-race-replacement");
      const { outbox, worker } = yield* makeWorker(harness, 1, {
        interruptAndAwaitTerminal: () =>
          Effect.sync(() => {
            const current = harness.projection();
            harness.setProjection({
              ...current,
              runs: current.runs.map((run) =>
                change === "stop"
                  ? { ...run, status: "interrupted" as const }
                  : { ...run, activeAttemptId: replacement },
              ),
            });
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ProviderTurnControl.ProviderTurnControlError({
                  threadId: harness.threadId,
                  operation: "restart",
                  providerTurnId,
                  cause: "interrupt failed",
                }),
              ),
            ),
          ),
      });
      const id = `effect:restart-race:${change}`;
      yield* outbox.enqueue([
        {
          id,
          commandId: CommandId.make(`command:restart-race:${change}`),
          threadId: harness.threadId,
          request: {
            type: "provider-turn.restart",
            runId: harness.runId,
            providerSessionId: ProviderSessionId.make("old-session"),
            providerThreadId: ProviderThreadId.make("old-thread"),
            providerTurnId,
            interruptedAttemptId: RunAttemptId.make("old-attempt"),
          },
        },
      ]);
      expect(yield* worker.runOnce).toBe(true);
      expect(harness.projection().runs.at(-1)).toMatchObject(
        change === "stop"
          ? { status: "interrupted" }
          : { status: "starting", activeAttemptId: replacement },
      );
      expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
);

effectIt.effect("restart cleanup without a starting identity does not settle another run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue" });
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, status: "interrupted" as const })),
    });
    const providerTurnId = ProviderTurnId.make("restart-missing-turn");
    const { outbox, worker } = yield* makeWorker(harness, 1, {
      interruptAndAwaitTerminal: () =>
        Effect.fail(
          new ProviderTurnControl.ProviderTurnControlError({
            threadId: harness.threadId,
            operation: "restart",
            providerTurnId,
            cause: "interrupt failed",
          }),
        ),
    });
    yield* outbox.enqueue([
      {
        id: "effect:restart-no-identity",
        commandId: CommandId.make("command:restart-no-identity"),
        threadId: harness.threadId,
        request: {
          type: "provider-turn.restart",
          runId: harness.runId,
          providerSessionId: ProviderSessionId.make("old-session"),
          providerThreadId: ProviderThreadId.make("old-thread"),
          providerTurnId,
          interruptedAttemptId: RunAttemptId.make("old-attempt"),
        },
      },
    ]);
    expect(yield* worker.runOnce).toBe(true);
    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);
