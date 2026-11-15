import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  ProviderInstanceId,
  ProviderSessionId,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../serverSettings.ts";
import * as RemoteReportInbox from "../remoteReports/RemoteReportInbox.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import { rootAppThread } from "./RunExecutionService.compactCases.ts";
import {
  backgroundScenarioIds,
  driver,
  mockEventSink,
  layerTurnItemPositionsTest,
  makeRunOwnedSubagentFixture,
  makeRunOwnedSubagentTurnItemFixture,
  makeRunOwnedSubagentNodeFixture,
  makeRunOwnedSubagentChildNodeFixture,
  childThreadCreatedEvent,
  rootTerminalEvent,
} from "./RunExecutionService.testkit.ts";

it.effect("settles native subagents when a workspace handoff completes the root run", () =>
  Effect.gen(function* () {
    const ids = backgroundScenarioIds("subagent-workspace-handoff");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const written = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          RemoteReportInbox.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            captureBaseline: () => Effect.void,
          }),
          layerTurnItemPositionsTest,
          mockEventSink({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Ref.update(written, (current) => [...current, ...input.events]).pipe(Effect.as([])),
            writeIfRunCurrent: (input) =>
              Ref.update(written, (current) => [...current, ...input.events]).pipe(
                Effect.as({ committed: true, storedEvents: [] }),
              ),
          }),
          Layer.merge(IdAllocator.layer, ThreadCommandExecutor.layer),
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const fixture = {
      ids,
      providerInstanceId,
      childThreadId: ids.childThreadId,
      driver,
      status: "running",
    } as const;
    const runningSubagent = makeRunOwnedSubagentFixture(fixture);
    const runningTurnItem = makeRunOwnedSubagentTurnItemFixture(fixture);
    const runningNode = makeRunOwnedSubagentNodeFixture({ ids, status: "running" });
    const runningChildNode = makeRunOwnedSubagentChildNodeFixture({ ids, status: "running" });

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:subagent-workspace-handoff"),
        appThread: rootAppThread(ids.threadId),
        providerSessionId: ProviderSessionId.make("session:subagent-workspace-handoff"),
        session: {
          events: Stream.empty,
          subscribeEvents: Effect.succeed({
            // The provider event stream stays open: only settled children may end ingestion.
            events: Stream.concat(
              Stream.fromIterable([
                childThreadCreatedEvent(ids),
                { type: "subagent.updated", driver, subagent: runningSubagent },
                { type: "node.updated", driver, node: runningNode },
                { type: "node.updated", driver, node: runningChildNode },
                { type: "turn_item.updated", driver, turnItem: runningTurnItem },
                rootTerminalEvent(ids, "interrupted"),
              ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
              Stream.never,
            ),
            close: Deferred.succeed(ingestionDone, undefined),
          }),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:subagent-workspace-handoff"),
        } as OrchestrationV2CheckpointScope,
        providerThread: { id: ids.providerThreadId, driver } as OrchestrationV2ProviderThread,
        attempt: {
          id: ids.attemptId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        providerTurnOrdinal: 1,
        shouldFinalizeRun: () => Effect.succeed(true),
        hasWorkspaceMoved: () => Effect.succeed(true),
        message: {
          messageId: MessageId.make("message:subagent-workspace-handoff:user"),
          text: "Spawn a subagent then move to a worktree.",
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
    }).pipe(Effect.provide(layerTest));

    yield* Deferred.await(ingestionDone);

    const events = yield* Ref.get(written);
    const statusOf = (type: OrchestrationV2DomainEvent["type"], id: string) =>
      events.flatMap((event) => {
        if (event.type !== type) return [];
        const payload = (
          event as { readonly payload: { readonly id: string; readonly status: string } }
        ).payload;
        return payload.id === id ? [payload.status] : [];
      });
    assert.deepEqual(statusOf("subagent.updated", runningSubagent.id), ["interrupted"]);
    assert.deepEqual(statusOf("turn-item.updated", runningTurnItem.id), ["interrupted"]);
    assert.deepEqual(statusOf("node.updated", runningNode.id), ["interrupted"]);
    assert.deepEqual(statusOf("node.updated", runningChildNode.id), ["interrupted"]);
    assert.deepEqual(statusOf("run.updated", ids.runId), ["waiting"]);
    assert.deepEqual(statusOf("run-attempt.updated", ids.attemptId), ["completed"]);
    assert.isFalse(
      events.some(
        (event) =>
          event.type === "turn-item.updated" && event.payload.type === "run_interrupt_result",
      ),
    );
  }),
);
