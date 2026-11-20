import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { CommandId, MessageId, RunId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

it.effect("recovery defers at most 64 unsent runs and visibly parks the overflow", () =>
  Effect.gen(function* () {
    const base = makeLocalCommandHarness({ text: "Run work", createdBy: "agent" }).projection();
    const states = new Map(
      Array.from({ length: 65 }, (_, index) => {
        const threadId = ThreadId.make(`capacity-thread:${index}`);
        const runId = RunId.make(`capacity-run:${index}`);
        const messageId = MessageId.make(`capacity-message:${index}`);
        const run = {
          ...base.runs[0]!,
          id: runId,
          threadId,
          userMessageId: messageId,
          status: "running" as const,
          startedAt: base.runs[0]!.requestedAt,
        };
        const attempt = { ...base.attempts[0]!, runId, inputDelivery: "unsent" as const };
        const message = {
          ...base.messages[0]!,
          id: messageId,
          threadId,
          runId,
          creationSource: "mcp" as const,
        };
        return [
          threadId,
          {
            ...base,
            thread: { ...base.thread, id: threadId },
            runs: [run],
            attempts: [attempt],
            nodes: base.nodes.map((node) => ({ ...node, runId })),
            messages: [message],
            providerTurns: [],
          },
        ] as const;
      }),
    );
    const commits: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
    const effects: NonNullable<
      Parameters<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>[0]["effects"]
    >[number][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([...states.keys()]),
            getRuntimeRecoveryProjection: (id) => Effect.succeed(states.get(id)!),
            getTurnStartContext: (id) =>
              Effect.succeed({ ...states.get(id)!, hasConversation: true }),
            getThreadRecords: (id) => Effect.succeed(states.get(id)! as never),
            getMessagesById: (id) =>
              Effect.succeed(
                new Map(states.get(id)!.messages.map((message) => [message.id, message])),
              ),
            getNextTurnItemOrdinal: () => Effect.succeed(1),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            latestSequence: () => Effect.succeed(1),
            commitCommand: (input) => {
              commits.push(input);
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
            writeIfRunCurrent: (input) => {
              effects.push(...(input.effects ?? []));
              return Effect.succeed({ committed: true, storedEvents: [] });
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            findOriginalStart: () =>
              Effect.succeedSome({ commandId: CommandId.make("original"), resendCount: 0 }),
            cancelUnsettled: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    expect(effects).toHaveLength(0);
    yield* Effect.gen(function* () {
      yield* recovery.drainDeferredResends(yield* ThreadCommandExecutor.ThreadCommandExecutor);
    }).pipe(Effect.provide(ThreadCommandExecutor.layer));
    expect(effects).toHaveLength(64);
    const overflow = commits.find(
      (commit) => commit.threadId === ThreadId.make("capacity-thread:64"),
    );
    expect(
      overflow?.events.some(
        (event) =>
          event.type === "run.updated" &&
          event.payload.status === "queued" &&
          event.payload.queueHeld,
      ),
    ).toBe(true);
    expect(
      overflow?.events.some(
        (event) =>
          event.type === "turn-item.updated" &&
          event.payload.type === "system_notice" &&
          event.payload.message.includes("decision"),
      ),
    ).toBe(true);
  }),
);
