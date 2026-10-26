import * as RemoteReportInbox from "../remoteReports/RemoteReportInbox.ts";

import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";

import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

export const driver = ProviderDriverKind.make("codex");

export const layerTurnItemPositionsTest = Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)(
  {
    allocate: () => Effect.succeed(1),
  },
);

export const layerRunExecutionTest = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layerEmpty,
      RemoteReportInbox.layerEmpty,
      Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
      layerTurnItemPositionsTest,
      Layer.mock(EventSink.EventSinkV2)({}),
      IdAllocator.layer,
      Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
        ingestNormalized: () => Effect.succeed([]),
      }),
      ServerSettings.layerTest(),
    ),
  ),
);

export function captureRootRunTermination(input: {
  readonly key: string;
  readonly shouldFinalizeRun: () => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>;
  readonly rejectTerminalWrite?: boolean;
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
  readonly loadRunInterruptReason?: () => Effect.Effect<string | undefined, never>;
  readonly seedOpenSubagent?: boolean;
  readonly events?: (
    ids: BackgroundScenarioIds,
  ) => Stream.Stream<
    ProviderAdapter.ProviderAdapterV2Event,
    ProviderAdapter.ProviderAdapterV2Error
  >;
  readonly startTurn?: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"];
  readonly interruptTurn?: ProviderAdapter.ProviderAdapterV2SessionRuntime["interruptTurn"];
  readonly initialProviderTurnId?: ProviderTurnId | null;
  readonly refreshAfterTurn?: Effect.Effect<void>;
  readonly shouldStartProviderTurn?: RunExecutionService.RunExecutionServiceV2StartRootRunInput["shouldStartProviderTurn"];
  readonly appContext?: ReturnType<McpAppModelContext.McpAppModelContext["Service"]["forThread"]>;
  readonly ingestNormalized?: ProviderEventIngestor.ProviderEventIngestorV2["Service"]["ingestNormalized"];
  readonly beforeTerminalWrite?: (
    request: Parameters<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>[0],
  ) => Effect.Effect<boolean, EventSink.EventSinkV2Error>;
}) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(input.key);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const runningSubagent = makeRunOwnedSubagentFixture({
      ids,
      providerInstanceId,
      childThreadId: ids.childThreadId,
      driver,
      status: "running",
    });
    const writtenItems = yield* Ref.make<ReadonlyArray<OrchestrationV2TurnItem>>([]);
    const finalEvents = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const submittedEffects = yield* Ref.make<ReadonlyArray<PendingOrchestrationEffectV2>>([]);
    const committedEffects = yield* Ref.make<ReadonlyArray<PendingOrchestrationEffectV2>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const captureTurnItem = (payload: OrchestrationV2TurnItem) =>
      Ref.update(writtenItems, (current) => [...current, payload]);
    const captureFinalEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        yield* Ref.update(finalEvents, (current) => [...current, ...events]);
        for (const event of events) {
          if (event.type === "turn-item.updated") {
            yield* captureTurnItem(event.payload);
          }
          if (event.type === "run.updated") {
            yield* Ref.update(observed, (current) => [...current, `run:${event.payload.status}`]);
          }
        }
      });
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(McpAppModelContext.McpAppModelContext)({
            forThread: () => input.appContext ?? Effect.succeed([]),
          }),
          RemoteReportInbox.layerEmpty,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            write: (payload) =>
              Effect.gen(function* () {
                for (const event of payload.events) {
                  if (event.type === "turn-item.updated") {
                    yield* captureTurnItem(event.payload);
                  }
                }
                return [];
              }),
            writeWithEffects: (payload) =>
              Effect.gen(function* () {
                yield* Ref.update(submittedEffects, (current) => [...current, ...payload.effects]);
                yield* Ref.update(committedEffects, (current) => [...current, ...payload.effects]);
                yield* captureFinalEvents(payload.events);
                return [];
              }),
            writeIfRunCurrent: (payload) =>
              Effect.gen(function* () {
                const effects = payload.effects ?? [];
                yield* Ref.update(submittedEffects, (current) => [...current, ...effects]);
                if (
                  input.rejectTerminalWrite === true ||
                  (input.beforeTerminalWrite !== undefined &&
                    !(yield* input.beforeTerminalWrite(payload)))
                ) {
                  return { committed: false, storedEvents: [] };
                }
                yield* Ref.update(committedEffects, (current) => [...current, ...effects]);
                yield* captureFinalEvents(payload.events);
                return { committed: true, storedEvents: [] };
              }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: input.ingestNormalized ?? (() => Effect.succeed([])),
          }),
          ServerSettings.layerTest(),
          Layer.succeed(RunFinalizationService.RunFinalizationObserver, {
            refresh: () => Effect.void,
            refreshAfterTurn: () =>
              Ref.update(observed, (current) => [...current, "pull-requests-refreshed"]).pipe(
                Effect.andThen(input.refreshAfterTurn ?? Effect.void),
              ),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${input.key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${input.key}`),
        session: {
          events: Stream.empty,
          subscribeEvents: Effect.succeed({
            events:
              input.events?.(ids) ??
              Stream.fromIterable([
                ...(input.seedOpenSubagent
                  ? [
                      { type: "subagent.updated", driver, subagent: runningSubagent } as const,
                      {
                        type: "node.updated",
                        driver,
                        node: makeRunOwnedSubagentNodeFixture({ ids, status: "running" }),
                      } as const,
                      {
                        type: "turn_item.updated",
                        driver,
                        turnItem: makeRunOwnedSubagentTurnItemFixture({
                          ids,
                          providerInstanceId,
                          childThreadId: ids.childThreadId,
                          driver,
                          status: "running",
                        }),
                      } as const,
                    ]
                  : []),
                rootTerminalEvent(ids, "interrupted"),
              ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
            close: Deferred.succeed(ingestionDone, undefined),
          }),
          startTurn: input.startTurn ?? (() => Effect.void),
          interruptTurn: input.interruptTurn ?? (() => Effect.void),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: {
          id: ids.rootNodeId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${input.key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ids.providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: ids.attemptId,
          providerTurnId:
            input.initialProviderTurnId === undefined
              ? ids.rootProviderTurnId
              : input.initialProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        providerTurnOrdinal: 1,
        shouldFinalizeRun: input.shouldFinalizeRun,
        ...(input.shouldStartProviderTurn === undefined
          ? {}
          : { shouldStartProviderTurn: input.shouldStartProviderTurn }),
        ...(input.hasUnpairedRunInterruptRequest === undefined
          ? {}
          : {
              hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
            }),
        ...(input.loadRunInterruptReason === undefined
          ? {}
          : { loadRunInterruptReason: input.loadRunInterruptReason }),
        message: {
          messageId: MessageId.make(`message:${input.key}`),
          text: "interrupt projection",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
      yield* Deferred.await(ingestionDone);
    }).pipe(Effect.provide(layerTest));
    return {
      written: yield* Ref.get(writtenItems),
      finalEvents: yield* Ref.get(finalEvents),
      observed: yield* Ref.get(observed),
      submittedEffects: yield* Ref.get(submittedEffects),
      committedEffects: yield* Ref.get(committedEffects),
    };
  });
}

export interface BackgroundScenarioIds {
  readonly threadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
  readonly rootProviderTurnId: ProviderTurnId;
  readonly rootNodeId: NodeId;
  readonly itemId: TurnItemId;
  readonly childItemId: TurnItemId;
  readonly subagentNodeId: NodeId;
}

export function backgroundScenarioIds(key: string): BackgroundScenarioIds {
  return {
    threadId: ThreadId.make(`thread:${key}`),
    childThreadId: ThreadId.make(`thread:${key}:child`),
    runId: RunId.make(`run:${key}`),
    attemptId: RunAttemptId.make(`attempt:${key}`),
    providerThreadId: ProviderThreadId.make(`provider-thread:${key}`),
    rootProviderTurnId: ProviderTurnId.make(`provider-turn:${key}`),
    rootNodeId: NodeId.make(`node:${key}`),
    itemId: TurnItemId.make(`turn-item:${key}`),
    childItemId: TurnItemId.make(`turn-item:${key}:child`),
    subagentNodeId: NodeId.make(`node:${key}:subagent`),
  };
}

export function childThreadCreatedEvent(
  ids: BackgroundScenarioIds,
): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "app_thread.created",
    driver,
    appThread: {
      id: ids.childThreadId,
      lineage: {
        parentThreadId: ids.threadId,
        relationshipToParent: "subagent",
        rootThreadId: ids.threadId,
      },
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
}

export function childBackgroundTurnItemEvent(
  ids: BackgroundScenarioIds,
  status: "running" | "completed" | "idle",
  ordinal: number,
): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: ids.childItemId,
      threadId: ids.childThreadId,
      runId: null,
      providerTurnId: null,
      ordinal,
      type: "command_execution",
      status,
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
}

export function backgroundTurnItemEvent(
  ids: BackgroundScenarioIds,
  type: "command_execution" | "dynamic_tool" | "subagent",
  status: "running" | "completed" | "idle",
  ordinal: number,
  itemId?: TurnItemId,
): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: itemId ?? ids.itemId,
      threadId: ids.threadId,
      runId: ids.runId,
      providerTurnId: ids.rootProviderTurnId,
      ordinal,
      type,
      status,
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
}

export function backgroundTurnItemEventForRun(
  ids: BackgroundScenarioIds,
  runId: RunId,
  type: "command_execution" | "dynamic_tool" | "subagent",
  status: "running" | "completed" | "idle",
  ordinal: number,
): ProviderAdapter.ProviderAdapterV2Event {
  const event = backgroundTurnItemEvent(ids, type, status, ordinal);
  if (event.type !== "turn_item.updated") {
    return event;
  }
  return { ...event, turnItem: { ...event.turnItem, runId } };
}

export function subagentEvent(
  ids: BackgroundScenarioIds,
  status: "running" | "completed" | "idle",
): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "subagent.updated",
    driver,
    subagent: {
      id: ids.subagentNodeId,
      threadId: ids.threadId,
      runId: ids.runId,
      status,
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
}

export function makeRunOwnedSubagentFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly providerInstanceId: ProviderInstanceId;
  readonly childThreadId: ThreadId;
  readonly driver: typeof driver;
  readonly status: "running" | "interrupted";
}): OrchestrationV2Subagent {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.subagentNodeId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    parentNodeId: input.ids.rootNodeId,
    origin: "provider_native",
    createdBy: "agent",
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    providerThreadId: null,
    childThreadId: input.childThreadId,
    nativeTaskRef: {
      driver: input.driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    prompt: "hold",
    title: "Live-test subagent hold",
    model: null,
    status: input.status,
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
}

export function makeRunOwnedSubagentTurnItemFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly providerInstanceId: ProviderInstanceId;
  readonly childThreadId: ThreadId;
  readonly driver: typeof driver;
  readonly status: "running" | "interrupted";
}): Extract<OrchestrationV2TurnItem, { type: "subagent" }> {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.itemId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    nodeId: input.ids.subagentNodeId,
    providerThreadId: input.ids.providerThreadId,
    providerTurnId: input.ids.rootProviderTurnId,
    nativeItemRef: {
      driver: input.driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    parentItemId: null,
    ordinal: 3,
    status: input.status,
    title: "Live-test subagent hold",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "subagent",
    subagentId: input.ids.subagentNodeId,
    origin: "provider_native",
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    childThreadId: input.childThreadId,
    prompt: "hold",
    result: null,
  };
}

export function makeLinkedChildTurnItemFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly driver: typeof driver;
  readonly type: "assistant_message" | "command_execution" | "reasoning";
}): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  const base = {
    id: input.ids.childItemId,
    threadId: input.ids.childThreadId,
    runId: null,
    nodeId: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running" as const,
    title: "Working",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  if (input.type === "assistant_message") {
    return {
      ...base,
      type: "assistant_message",
      messageId: MessageId.make(`${input.ids.childItemId}:message`),
      text: "partial response",
      streaming: true,
    };
  }
  if (input.type === "reasoning") {
    return {
      ...base,
      type: "reasoning",
      text: "partial progress",
      streaming: true,
    };
  }
  return {
    ...base,
    type: "command_execution",
    input: "sleep 300",
  };
}

export function makeRunOwnedSubagentNodeFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly status: "running" | "interrupted";
}): OrchestrationV2ExecutionNode {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.subagentNodeId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    parentNodeId: input.ids.rootNodeId,
    rootNodeId: input.ids.rootNodeId,
    kind: "subagent",
    status: input.status,
    countsForRun: false,
    providerThreadId: input.ids.providerThreadId,
    providerTurnId: input.ids.rootProviderTurnId,
    nativeItemRef: {
      driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}

export function makeRunOwnedSubagentChildNodeFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly status: "running" | "interrupted";
}): OrchestrationV2ExecutionNode {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    threadId: input.ids.childThreadId,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    kind: "root_turn",
    status: input.status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}

export function rootTerminalEvent(
  ids: BackgroundScenarioIds,
  status: "completed" | "interrupted" | "cancelled" | "failed",
): ProviderAdapter.ProviderAdapterV2Event {
  const common = {
    type: "turn.terminal" as const,
    driver,
    providerThreadId: ids.providerThreadId,
    providerTurnId: ids.rootProviderTurnId,
    runOrdinal: 1,
    threadDisposition: "reusable" as const,
  };
  return status === "failed"
    ? {
        ...common,
        status,
        failureItemOrdinal: 101,
        failure: {
          class: "provider_error",
          message: "Provider failed",
          code: null,
          retryable: null,
        },
      }
    : { ...common, status, failure: null };
}
