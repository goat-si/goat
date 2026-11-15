import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  TurnItemId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import type * as Fixture from "./ProviderSessionManager.test.ts";
import {
  CODEX_DRIVER,
  ExclusiveCapabilities,
  emptyState,
  makeProviderThread,
  modelSelection,
  runtimePolicy,
} from "./ProviderSessionFixture.testkit.ts";

export function registerReleasedBackgroundWorkChecks({
  makeThreadCreatedEvent,
  layerTest,
}: {
  makeThreadCreatedEvent: typeof Fixture.makeThreadCreatedEvent;
  layerTest: typeof Fixture.layerTest;
}) {
  const openSessionWithBackgroundCommand = (fixtureName: string) =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName,
        projectId: yield* idAllocator.allocate.project({ fixtureName }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const otherProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const pendingBackgroundTasks = [
        { taskId: "dev-server", kind: "command", description: "python3 -m http.server" },
      ] as const;
      const providerThreads = [
        {
          ...makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
          pendingBackgroundTasks,
        },
        {
          ...makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId: otherProviderSessionId,
            now,
            nativeThreadId: "native-thread-other-session",
          }),
          pendingBackgroundTasks,
        },
      ] as const;
      const writeProviderThread = (payload: OrchestrationV2ProviderThread) =>
        Effect.gen(function* () {
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId }),
                type: "provider-thread.updated",
                threadId,
                driver: CODEX_DRIVER,
                occurredAt: now,
                payload,
              },
            ],
          });
        });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* Effect.forEach(providerThreads, writeProviderThread);
      const toolCall = (
        nativeItemId: string,
        providerThread: OrchestrationV2ProviderThread,
        status: "running" | "completed",
        startedAt: DateTime.Utc,
      ) =>
        ({
          id: idAllocator.derive.turnItemFromProviderItem({ driver: CODEX_DRIVER, nativeItemId }),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status,
          title: null,
          startedAt,
          completedAt: status === "completed" ? startedAt : null,
          updatedAt: startedAt,
          type: "dynamic_tool",
          toolName: "mcp__goat__goat_worktree_handoff",
          input: {},
        }) satisfies OrchestrationV2TurnItem;
      const seededToolCalls = {
        cutOff: toolCall("cut-off", providerThreads[0], "running", now),
        finished: toolCall("finished", providerThreads[0], "completed", now),
        otherSession: toolCall("other-session", providerThreads[1], "running", now),
        // Started by a replacement session after the release.
        replacement: toolCall(
          "replacement",
          providerThreads[0],
          "running",
          DateTime.add(now, { hours: 1 }),
        ),
      };
      const writeToolCall = (payload: OrchestrationV2TurnItem) =>
        Effect.gen(function* () {
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId }),
                type: "turn-item.updated",
                threadId,
                driver: CODEX_DRIVER,
                occurredAt: now,
                payload,
              },
            ],
          });
        });
      yield* Effect.forEach(Object.values(seededToolCalls), writeToolCall);
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const toolCallStatus = (id: OrchestrationV2TurnItem["id"]) =>
        Effect.gen(function* () {
          const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
          const projection = yield* projectionStore.getThreadProjection(threadId);
          return projection.turnItems.find((item) => item.id === id)?.status;
        });
      const toolCalls = Effect.gen(function* () {
        const statusOf = (seeded: OrchestrationV2TurnItem) => toolCallStatus(seeded.id);
        return {
          cutOff: yield* statusOf(seededToolCalls.cutOff),
          finished: yield* statusOf(seededToolCalls.finished),
          otherSession: yield* statusOf(seededToolCalls.otherSession),
          replacement: yield* statusOf(seededToolCalls.replacement),
        };
      });
      const rosters = Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const projection = yield* projectionStore.getThreadProjection(threadId);
        return providerThreads.map((seeded) =>
          (
            projection.providerThreads.find((thread) => thread.id === seeded.id)
              ?.pendingBackgroundTasks ?? []
          ).map((task) => task.taskId),
        );
      });
      return {
        threadId,
        providerSessionId,
        providerThreads,
        writeProviderThread,
        rosters,
        seededToolCalls,
        writeToolCall,
        toolCalls,
        toolCallStatus,
      };
    });

  // regression: a worktree handoff left its tool call running, so the thread stayed Waiting
  it.effect.each(["detach", "stream failure", "provider stop", "early close"] as const)(
    "ProviderSessionManagerV2 clears background work after queued events drain on %s",
    (release) =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const effect = Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const {
            threadId,
            providerSessionId,
            rosters,
            toolCalls,
            seededToolCalls,
            writeToolCall,
          } = yield* openSessionWithBackgroundCommand("provider-session-manager-detach-roster");
          const runtime = Option.getOrThrow(yield* manager.get(providerSessionId));
          if (runtime.subscribeEvents === undefined) return assert.fail("no event subscription");
          const subscription = yield* runtime.subscribeEvents;
          const consuming = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const consumer = yield* subscription.events.pipe(
            Stream.tap(() =>
              Deferred.succeed(consuming, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(writeToolCall(seededToolCalls.cutOff)),
              ),
            ),
            (events) => (release === "early close" ? events.pipe(Stream.take(1)) : events),
            Stream.runDrain,
            Effect.exit,
            Effect.forkScoped,
          );
          const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
          if (queue === undefined) return assert.fail("no provider event queue");
          yield* Queue.offer(queue, {
            type: "provider_session.updated",
            driver: CODEX_DRIVER,
            providerSession: runtime.providerSession,
          });
          yield* Deferred.await(consuming);
          assert.deepStrictEqual(yield* rosters, [["dev-server"], ["dev-server"]]);

          const eventSink = yield* EventSink.EventSinkV2;
          const afterSequence = yield* eventSink.latestSequence({ threadId });
          if (release === "detach" || release === "early close") {
            yield* manager.detach({ providerSessionId, threadId, detail: "Workspace changed." });
          } else {
            if (release === "provider stop") {
              yield* Queue.offer(queue, {
                type: "provider_session.updated",
                driver: CODEX_DRIVER,
                providerSession: { ...runtime.providerSession, status: "stopped" },
              });
            }
            yield* Queue.end(queue);
          }
          const interrupts = (count: number) =>
            eventSink.stream({ threadId, afterSequence }).pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "turn-item.updated" &&
                  event.payload.id === seededToolCalls.cutOff.id &&
                  event.payload.status === "interrupted",
              ),
              Stream.take(count),
              Stream.runDrain,
            );
          yield* interrupts(1);
          yield* Deferred.succeed(resume, undefined);
          assert.equal(
            Exit.isFailure(yield* Fiber.join(consumer)),
            release !== "provider stop" && release !== "early close",
          );
          yield* interrupts(2);

          assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
          assert.deepStrictEqual(yield* rosters, [[], ["dev-server"]]);
          assert.deepStrictEqual(yield* toolCalls, {
            cutOff: "interrupted",
            finished: "completed",
            otherSession: "running",
            replacement: "running",
          });
        });

        yield* effect.pipe(
          Effect.provide(
            layerTest({ state, idleTimeoutMs: 60_000, capabilities: ExclusiveCapabilities }),
          ),
        );
      }),
  );

  it.effect.each(["a runtime whose tasks can outlive it", "server shutdown"] as const)(
    "ProviderSessionManagerV2 keeps the background work after the release of %s",
    (release) =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const effect = Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const { providerSessionId, rosters, toolCalls } = yield* openSessionWithBackgroundCommand(
            "provider-session-manager-outliving-roster",
          );

          yield* release === "server shutdown"
            ? manager.release({ providerSessionId, reason: "server_shutdown" })
            : manager.close(providerSessionId);

          assert.deepStrictEqual(yield* rosters, [["dev-server"], ["dev-server"]]);
          assert.equal((yield* toolCalls).cutOff, "running");
        });

        yield* effect.pipe(
          Effect.provide(
            layerTest({
              state,
              idleTimeoutMs: 60_000,
              ...(release === "server shutdown" ? {} : { backgroundTasksEndWithProcess: false }),
            }),
          ),
        );
      }),
  );

  it.effect("ProviderSessionManagerV2 keeps provider updates that land while release clears", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const beforeUnchangedWrite = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      const beforeTurnItemsWrite = yield* Ref.make<ReadonlyArray<Effect.Effect<void>>>([]);
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const {
          providerSessionId,
          providerThreads,
          writeProviderThread,
          rosters,
          seededToolCalls,
          writeToolCall,
          toolCallStatus,
        } = yield* openSessionWithBackgroundCommand("provider-session-manager-raced-roster");
        // Before each of the first four cleanup writes, one of these calls completes late. The
        // completion must win, and the conflicts must not stop the open calls from being interrupted.
        const lateCall = (name: string) => ({
          ...seededToolCalls.cutOff,
          id: TurnItemId.make(`turn-item:${name}`),
        });
        const lateCompleted = [
          lateCall("late-1"),
          lateCall("late-2"),
          lateCall("late-3"),
          lateCall("late-4"),
        ] as const;
        // Read after the late calls, so one write for all items would run out of tries first.
        const lastOpen = { ...seededToolCalls.cutOff, id: TurnItemId.make("turn-item:last-open") };
        yield* Effect.forEach([...lateCompleted, lastOpen], writeToolCall);
        const storedLate = {
          ...seededToolCalls.cutOff,
          id: TurnItemId.make("turn-item:stored-late"),
        };
        const storedInCleanPass = {
          ...seededToolCalls.cutOff,
          id: TurnItemId.make("turn-item:stored-in-clean-pass"),
        };
        const complete = (item: OrchestrationV2TurnItem) =>
          writeToolCall({ ...item, status: "completed" });
        // One hook runs before each cleanup write. The first pass writes the cut-off call, the
        // four late calls and the last open call; the second pass writes the cut-off call again
        // and the call stored late; the third pass writes the call stored in the clean pass.
        yield* Ref.set(
          beforeTurnItemsWrite,
          [
            // The cut-off call gets an update that keeps it open, so it needs a second pass, and
            // the dead session stores one more call.
            complete(lateCompleted[0]).pipe(
              Effect.andThen(writeToolCall({ ...seededToolCalls.cutOff, title: "late output" })),
              Effect.andThen(writeToolCall(storedLate)),
            ),
            complete(lateCompleted[1]),
            complete(lateCompleted[2]),
            complete(lateCompleted[3]),
            Effect.void,
            Effect.void,
            // The second pass has no conflict, but one more call lands during it.
            writeToolCall(storedInCleanPass),
          ].map(Effect.orDie),
        );
        const seeded = providerThreads[0];
        yield* Ref.set(
          beforeUnchangedWrite,
          writeProviderThread({
            ...seeded,
            pendingBackgroundTasks: [
              ...seeded.pendingBackgroundTasks,
              { taskId: "replacement-task", kind: "command" },
            ],
          }).pipe(Effect.orDie),
        );

        yield* manager.close(providerSessionId);

        assert.deepStrictEqual(yield* rosters, [["replacement-task"], ["dev-server"]]);
        const statuses = Object.fromEntries(
          yield* Effect.forEach(
            [seededToolCalls.cutOff, ...lateCompleted, lastOpen, storedLate, storedInCleanPass],
            (item) => toolCallStatus(item.id).pipe(Effect.map((status) => [item.id, status])),
          ),
        );
        assert.deepStrictEqual(statuses, {
          [seededToolCalls.cutOff.id]: "interrupted",
          ...Object.fromEntries(lateCompleted.map((item) => [item.id, "completed"])),
          [lastOpen.id]: "interrupted",
          [storedLate.id]: "interrupted",
          [storedInCleanPass.id]: "interrupted",
        });
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, beforeUnchangedWrite, beforeTurnItemsWrite }),
        ),
      );
    }),
  );
}
