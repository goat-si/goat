import { CommandId, ProviderTurnId } from "@goat/contracts";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
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

it.effect("recovery holds a human prompt recorded unsent after the run became running", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Do this with the image" });
    const base = harness.projection();
    const run = {
      ...base.runs[0]!,
      status: "running" as const,
      startedAt: base.runs[0]!.requestedAt,
    };
    const attempt = { ...base.attempts[0]!, inputDelivery: "unsent" as const };
    const image = {
      type: "image" as const,
      id: "recovery-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 100,
    };
    const messages = base.messages.map((message) => ({ ...message, attachments: [image] }));
    const projection = { ...base, runs: [run], attempts: [attempt], messages, providerTurns: [] };
    let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([harness.threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            getThreadRecords: () => Effect.succeed(projection as never),
            getMessagesById: () =>
              Effect.succeed(new Map(messages.map((message) => [message.id, message]))),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committed = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listNeverAttemptedStarts: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    const updated = committed?.events.find(
      (event) => event.type === "run.updated" && event.runId === run.id,
    );
    expect(updated?.payload).toMatchObject({ status: "queued", queueHeld: true });
    expect(
      committed?.effects.filter((effect) => effect.request.type === "provider-turn.start"),
    ).toHaveLength(0);
    expect(messages[0]).toMatchObject({ text: "Do this with the image", attachments: [image] });
  }),
);

it.effect("recovery does not hold a prompt with persisted provider acceptance", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Do this with the image" });
    const base = harness.projection();
    const run = {
      ...base.runs[0]!,
      status: "starting" as const,
      startedAt: null,
    };
    const attempt = { ...base.attempts[0]!, inputDelivery: "accepted" as const };
    const image = {
      type: "image" as const,
      id: "recovery-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 100,
    };
    const messages = base.messages.map((message) => ({ ...message, attachments: [image] }));
    const projection = { ...base, runs: [run], attempts: [attempt], messages, providerTurns: [] };
    let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([harness.threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            getThreadRecords: () => Effect.succeed(projection as never),
            getMessagesById: () =>
              Effect.succeed(new Map(messages.map((message) => [message.id, message]))),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committed = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listNeverAttemptedStarts: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    const updated = committed?.events.find(
      (event) => event.type === "run.updated" && event.runId === run.id,
    );
    expect(updated?.payload).toMatchObject({ status: "cancelled" });
    expect(
      committed?.effects.filter((effect) => effect.request.type === "provider-turn.start"),
    ).toHaveLength(0);
    expect(messages[0]).toMatchObject({ text: "Do this with the image", attachments: [image] });
  }),
);

it.effect("recovery resends confirmed-unsent unattended work in its original run and command", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Run the scheduled work", createdBy: "agent" });
    const base = harness.projection();
    const run = {
      ...base.runs[0]!,
      status: "running" as const,
      startedAt: base.runs[0]!.requestedAt,
    };
    const attempt = { ...base.attempts[0]!, inputDelivery: "unsent" as const };
    const messages = base.messages.map((message) => ({
      ...message,
      creationSource: "mcp" as const,
    }));
    const projection = {
      ...base,
      thread: {
        ...base.thread,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: harness.threadId,
        },
      },
      runs: [run],
      attempts: [attempt],
      messages,
      providerTurns: [],
    };
    let enqueued: Parameters<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>[0]["effects"];
    let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([harness.threadId]),
            getTurnStartContext: () => Effect.succeed({ ...projection, hasConversation: true }),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            getThreadRecords: () => Effect.succeed(projection as never),
            getMessagesById: () =>
              Effect.succeed(new Map(messages.map((message) => [message.id, message]))),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            latestSequence: () => Effect.succeed(1),
            writeIfRunCurrent: (input) => {
              enqueued = input.effects;
              return Effect.succeed({ committed: true, storedEvents: [] });
            },
            commitCommand: (input) => {
              committed = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            cancelUnsettled: () => Effect.succeed([]),
            findOriginalStart: () =>
              Effect.succeedSome({
                commandId: CommandId.make("original-command"),
                resendCount: 0,
              } as never),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    expect(
      committed?.effects.filter((effect) => effect.request.type === "provider-turn.start") ?? [],
    ).toHaveLength(0);
    yield* Effect.gen(function* () {
      yield* recovery.drainDeferredResends(yield* ThreadCommandExecutor.ThreadCommandExecutor);
    }).pipe(Effect.provide(ThreadCommandExecutor.layer));
    const resend = enqueued?.find((effect) => effect.request.type === "provider-turn.start");
    expect(resend).toMatchObject({
      commandId: "original-command",
      request: { type: "provider-turn.start", runId: run.id },
    });
  }),
);

it.effect("ambiguous unattended delivery is held for a person, never resent", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Do this with the image", createdBy: "agent" });
    const base = harness.projection();
    const run = {
      ...base.runs[0]!,
      status: "running" as const,
      startedAt: base.runs[0]!.requestedAt,
    };
    const attempt = { ...base.attempts[0]!, inputDelivery: "ambiguous" as const };
    const image = {
      type: "image" as const,
      id: "recovery-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 100,
    };
    const messages = base.messages.map((message) => ({
      ...message,
      creationSource: "mcp" as const,
      attachments: [image],
    }));
    const projection = { ...base, runs: [run], attempts: [attempt], messages, providerTurns: [] };
    let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([harness.threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            getThreadRecords: () => Effect.succeed(projection as never),
            getNextTurnItemOrdinal: () => Effect.succeed(1),
            getMessagesById: () =>
              Effect.succeed(new Map(messages.map((message) => [message.id, message]))),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committed = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listNeverAttemptedStarts: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    const updated = committed?.events.find(
      (event) => event.type === "run.updated" && event.runId === run.id,
    );
    expect(updated?.payload).toMatchObject({ status: "queued", queueHeld: true });
    expect(
      committed?.effects.filter((effect) => effect.request.type === "provider-turn.start"),
    ).toHaveLength(0);
    expect(
      committed?.events.some(
        (event) =>
          event.type === "turn-item.updated" &&
          event.payload.type === "system_notice" &&
          event.payload.message.includes("decision"),
      ),
    ).toBe(true);
    expect(messages[0]).toMatchObject({
      text: "Do this with the image",
      createdBy: "agent",
      attachments: [image],
    });
  }),
);

it.effect("a finished provider turn prevents a duplicate unattended resend", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Run the scheduled work", createdBy: "agent" });
    const base = harness.projection();
    const run = {
      ...base.runs[0]!,
      status: "running" as const,
      startedAt: base.runs[0]!.requestedAt,
    };
    const attempt = { ...base.attempts[0]!, inputDelivery: "unsent" as const };
    const messages = base.messages.map((message) => ({
      ...message,
      creationSource: "mcp" as const,
    }));
    const projection = { ...base, runs: [run], attempts: [attempt], messages, providerTurns: [] };
    const historical = {
      ...projection,
      providerTurns: [
        {
          id: ProviderTurnId.make("historical-turn"),
          providerThreadId: run.providerThreadId!,
          runAttemptId: attempt.id,
          nodeId: run.rootNodeId!,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed" as const,
          startedAt: run.startedAt!,
          completedAt: run.startedAt!,
        },
      ],
    };
    let enqueued: Parameters<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>[0]["effects"];
    let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([harness.threadId]),
            getTurnStartContext: () => Effect.succeed({ ...projection, hasConversation: true }),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            getThreadRecords: () => Effect.succeed(historical as never),
            getMessagesById: () =>
              Effect.succeed(new Map(messages.map((message) => [message.id, message]))),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            latestSequence: () => Effect.succeed(1),
            writeIfRunCurrent: (input) => {
              enqueued = input.effects;
              return Effect.succeed({ committed: true, storedEvents: [] });
            },
            commitCommand: (input) => {
              committed = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            cancelUnsettled: () => Effect.succeed([]),
            findOriginalStart: () =>
              Effect.succeedSome({
                commandId: CommandId.make("original-command"),
                resendCount: 0,
              } as never),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    expect(
      committed?.effects.filter((effect) => effect.request.type === "provider-turn.start") ?? [],
    ).toHaveLength(0);
    yield* Effect.gen(function* () {
      yield* recovery.drainDeferredResends(yield* ThreadCommandExecutor.ThreadCommandExecutor);
    }).pipe(Effect.provide(ThreadCommandExecutor.layer));
    const resend = enqueued?.find((effect) => effect.request.type === "provider-turn.start");
    expect(resend).toBeUndefined();
  }),
);

it.effect("the resend budget parks unattended work instead of retrying again", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Do this with the image", createdBy: "agent" });
    const base = harness.projection();
    const run = {
      ...base.runs[0]!,
      status: "running" as const,
      startedAt: base.runs[0]!.requestedAt,
    };
    const attempt = { ...base.attempts[0]!, inputDelivery: "unsent" as const };
    const image = {
      type: "image" as const,
      id: "recovery-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 100,
    };
    const messages = base.messages.map((message) => ({
      ...message,
      creationSource: "mcp" as const,
      attachments: [image],
    }));
    const projection = { ...base, runs: [run], attempts: [attempt], messages, providerTurns: [] };
    let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([harness.threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            getThreadRecords: () => Effect.succeed(projection as never),
            getNextTurnItemOrdinal: () => Effect.succeed(1),
            getMessagesById: () =>
              Effect.succeed(new Map(messages.map((message) => [message.id, message]))),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committed = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            findOriginalStart: () =>
              Effect.succeedSome({ commandId: CommandId.make("original"), resendCount: 3 }),
            listNeverAttemptedStarts: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    const updated = committed?.events.find(
      (event) => event.type === "run.updated" && event.runId === run.id,
    );
    expect(updated?.payload).toMatchObject({ status: "queued", queueHeld: true });
    expect(
      committed?.effects.filter((effect) => effect.request.type === "provider-turn.start"),
    ).toHaveLength(0);
    expect(
      committed?.events.some(
        (event) =>
          event.type === "turn-item.updated" &&
          event.payload.type === "system_notice" &&
          event.payload.message.includes("decision"),
      ),
    ).toBe(true);
    expect(messages[0]).toMatchObject({
      text: "Do this with the image",
      createdBy: "agent",
      attachments: [image],
    });
  }),
);
