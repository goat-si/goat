import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { CommandId, NodeId, RunId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";
import { makeDeferredRecoveryResends } from "./goat/DeferredRecoveryResends.ts";

it.effect.each(["stopped", "inactive", "active", "human"] as const)(
  "recovery respects parent ownership: %s",
  (scenario) =>
    Effect.gen(function* () {
      const base = makeLocalCommandHarness({ text: "Child work" }).projection();
      const parentThreadId = ThreadId.make("parent-stop-thread");
      const parentRunId = RunId.make("parent-stop-run");
      const taskId = NodeId.make("parent-stop-task");
      const run = { ...base.runs[0]!, status: "starting" as const, delegatedTaskId: taskId };
      const attempt = { ...base.attempts[0]!, inputDelivery: "unsent" as const };
      const projection = {
        ...base,
        thread: {
          ...base.thread,
          lineage: {
            ...base.thread.lineage,
            relationshipToParent: scenario === "human" ? null : ("subagent" as const),
            parentThreadId: scenario === "human" ? null : parentThreadId,
          },
        },
        runs: [run],
        attempts: [attempt],
        providerTurns: [],
        hasConversation: true,
      };
      let commits = 0;
      const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getTurnStartContext: () => Effect.succeed(projection),
            getThreadRecords: () =>
              Effect.succeed({
                subagents: [
                  {
                    id: taskId,
                    runId: parentRunId,
                    status: scenario === "inactive" ? "completed" : "running",
                    result: null,
                  },
                ],
                turnItems:
                  scenario === "stopped"
                    ? [{ type: "run_interrupt_request", runId: parentRunId }]
                    : [],
              } as never),
          }),
        ),
      );
      const sink = yield* EventSink.EventSinkV2.pipe(
        Effect.provide(
          Layer.mock(EventSink.EventSinkV2)({
            latestSequence: () => Effect.succeed(1),
            writeIfRunCurrent: () =>
              Effect.sync(() => {
                commits++;
                return { committed: true, storedEvents: [] };
              }),
          }),
        ),
      );
      const ids = yield* IdAllocator.IdAllocatorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2.pipe(
        Effect.provide(
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            hasDelegatedStop: () => Effect.succeed(scenario === "stopped"),
          }),
        ),
      );
      const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const deferred = makeDeferredRecoveryResends({ projections, sink, ids, outbox });
      expect(
        deferred.reserve({
          threadId: run.threadId,
          run,
          attemptId: attempt.id,
          commandId: CommandId.make("child-original"),
          resendCount: 0,
        }),
      ).toBe(true);
      yield* deferred.captureSequence(run.threadId);
      yield* deferred.drain(locks);
      expect(commits).toBe(scenario === "stopped" ? 0 : 1);
    }).pipe(Effect.provide(Layer.mergeAll(IdAllocator.layer, ThreadCommandExecutor.layer))),
);

it.effect("a malformed lineage fails only its recovery candidate", () =>
  Effect.gen(function* () {
    const base = makeLocalCommandHarness({ text: "Work" }).projection();
    const ids = yield* IdAllocator.IdAllocatorV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2.pipe(
      Effect.provide(Layer.mock(EffectOutbox.EffectOutboxV2)({})),
    );
    const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const bad = ThreadId.make("lineage-bad");
    const good = ThreadId.make("lineage-good");
    const sent: ThreadId[] = [];
    const logs: unknown[] = [];
    const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
      Effect.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: (threadId) =>
            Effect.succeed({
              ...base,
              thread: {
                ...base.thread,
                id: threadId,
                lineage:
                  threadId === bad
                    ? null
                    : { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              },
              runs: [{ ...base.runs[0]!, threadId, status: "starting" }],
              attempts: [{ ...base.attempts[0]!, inputDelivery: "unsent" }],
              providerTurns: [],
              hasConversation: true,
            } as never),
        }),
      ),
    );
    const sink = yield* EventSink.EventSinkV2.pipe(
      Effect.provide(
        Layer.mock(EventSink.EventSinkV2)({
          latestSequence: () => Effect.succeed(1),
          writeIfRunCurrent: (input) =>
            Effect.sync(() => {
              sent.push(input.threadId);
              return { committed: true, storedEvents: [] };
            }),
        }),
      ),
    );
    const deferred = makeDeferredRecoveryResends({ projections, sink, ids, outbox });
    for (const threadId of [bad, good]) {
      const run = { ...base.runs[0]!, threadId, status: "starting" as const };
      expect(
        deferred.reserve({
          threadId,
          run,
          attemptId: base.attempts[0]!.id,
          commandId: CommandId.make(`lineage:${threadId}`),
          resendCount: 0,
        }),
      ).toBe(true);
      yield* deferred.captureSequence(threadId);
    }
    yield* deferred.drain(locks).pipe(
      Effect.provide(
        Logger.layer(
          [
            Logger.make(({ message }) => {
              logs.push(message);
            }),
          ],
          { mergeWithExisting: false },
        ),
      ),
    );
    expect(sent).toEqual([good]);
    expect(
      logs.filter(
        (message) => Array.isArray(message) && message[0] === "Deferred recovery start failed",
      ),
    ).toHaveLength(1);
  }).pipe(Effect.provide(Layer.mergeAll(IdAllocator.layer, ThreadCommandExecutor.layer))),
);
