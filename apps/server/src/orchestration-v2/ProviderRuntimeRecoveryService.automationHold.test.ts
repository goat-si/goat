import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as AutomationHold from "../automationHold.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";

it.effect("creates no startup continuation while held and permits it after release", () =>
  Effect.gen(function* () {
    const hold = yield* AutomationHold.makeInMemory({
      reason: "channel-copy",
      heldAt: "2026-10-25T00:00:00.000Z",
    });
    const threadId = ThreadId.make("thread-held-recovery");
    const runId = RunId.make("run-held-recovery");
    const providerThreadId = ProviderThreadId.make("provider-held-recovery");
    const sessionId = ProviderSessionId.make("session-held-recovery");
    const attemptId = RunAttemptId.make("attempt-held-recovery");
    const instanceId = ProviderInstanceId.make("codex");
    const driver = ProviderDriverKind.make("codex");
    const now = yield* DateTime.now;
    const projection = {
      ...idleThreadProjection(liveThreadShell(threadId)),
      thread: { ...liveThreadShell(threadId), providerInstanceId: instanceId },
      runs: [
        {
          id: runId,
          status: "running",
          providerInstanceId: instanceId,
          providerThreadId,
          activeAttemptId: attemptId,
          startedAt: now,
          requestedAt: now,
        },
      ],
      providerThreads: [
        {
          id: providerThreadId,
          appThreadId: threadId,
          ownerNodeId: null,
          providerInstanceId: instanceId,
          providerSessionId: sessionId,
          driver,
          status: "active",
          nativeThreadRef: { nativeId: "native", strength: "strong", driver },
        },
      ],
      providerSessions: [
        { id: sessionId, providerInstanceId: instanceId, driver, status: "ready" },
      ],
      providerTurns: [
        {
          id: ProviderTurnId.make("turn-held-recovery"),
          providerThreadId,
          providerSessionId: sessionId,
          runAttemptId: attemptId,
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const commits: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) =>
              Effect.sync(() => {
                commits.push(input);
                return { committed: true, cancelledEffectCount: 0 } as never;
              }),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      yield* recovery.reconcile("startup");
      assert.isEmpty(commits.flatMap((commit) => commit.effects));
      assert.isTrue(
        commits
          .flatMap((commit) => commit.events)
          .some((event) => event.type === "run.updated" && event.payload.status === "cancelled"),
      );
      yield* hold.release;
      commits.length = 0;
      yield* recovery.reconcile("startup");
      assert.deepEqual(
        commits.flatMap((commit) => commit.effects).map((effect) => effect.request.type),
        ["provider-runtime.continue"],
      );
    }).pipe(Effect.provide(layer), Effect.provideService(AutomationHold.AutomationHold, hold));
  }),
);
