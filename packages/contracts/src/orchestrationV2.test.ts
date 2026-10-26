import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaGetter from "effect/SchemaGetter";

import {
  CommandId,
  EnvironmentId,
  RuntimeRequestId,
  UserInputRespondedBy,
  UserInputResponseReason,
  UserInputAttachmentAnswerPayload,
  describeUserInputResponder,
  EventId,
  NodeId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./index.ts";
import {
  latestProviderTurnForAttempt,
  OrchestrationV2RunJson,
  OrchestrationV2QuestionEscalation,
  OrchestrationV2QuestionResolution,
  OrchestrationV2AppThread,
  OrchestrationV2AppThreadJson,
  OrchestrationV2NotificationSource,
  OrchestrationV2ThreadShellJson,
  OrchestrationV2RuntimeRequestJson,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2RpcSchemas,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShellJson,
  OrchestrationV2SubagentJson,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  OrchestrationV2Command,
  OrchestrationV2ThreadShell,
} from "./orchestrationV2.ts";

const now = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");

const decodeOrchestrationV2TurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeOrchestrationV2TurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);

const decodeOrchestrationV2DomainEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);

const encodeOrchestrationV2Subagent = Schema.encodeSync(OrchestrationV2Subagent);
const decodeOrchestrationV2Subagent = Schema.decodeUnknownSync(OrchestrationV2Subagent);
const encodeOrchestrationV2SubagentJson = Schema.encodeSync(OrchestrationV2SubagentJson);
const decodeOrchestrationV2SubagentJson = Schema.decodeUnknownSync(OrchestrationV2SubagentJson);

const decodeOrchestrationV2ProviderThreadJson = Schema.decodeUnknownSync(
  OrchestrationV2ProviderThreadJson,
);
const encodeOrchestrationV2ProviderThreadJson = Schema.encodeSync(
  OrchestrationV2ProviderThreadJson,
);
const decodeOrchestrationV2ProviderThread = Schema.decodeUnknownSync(OrchestrationV2ProviderThread);
const decodeOrchestrationV2ProviderCapabilities = Schema.decodeUnknownSync(
  OrchestrationV2ProviderCapabilities,
);

describe("orchestration V2 contracts", () => {
  it("decodes thread event types from a newer server as skippable items", () => {
    const decodeWireItems = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.Array(OrchestrationV2RpcSchemas.subscribeThread.output)),
    );
    const detached = (id: string, sequence: number) => ({
      kind: "event",
      sequence,
      event: {
        id,
        type: "provider-session.detached",
        threadId: "thread-1",
        occurredAt: DateTime.formatIso(now),
        payload: { providerSessionId: "provider-session-1", detachedAt: DateTime.formatIso(now) },
      },
    });

    const items = decodeWireItems([
      detached("event-1", 1),
      {
        kind: "event",
        sequence: 2,
        event: {
          id: "event-2",
          type: "run.from-a-future-server",
          threadId: "thread-1",
          occurredAt: DateTime.formatIso(now),
          payload: { runId: "run-1" },
        },
      },
      detached("event-3", 3),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["event", "unknown-event", "event"]);
    expect(items[1]).toEqual({
      kind: "unknown-event",
      sequence: 2,
      eventType: "run.from-a-future-server",
    });
    expect(() =>
      decodeWireItems([
        { ...detached("event-4", 4), event: { ...detached("event-4", 4).event, payload: {} } },
      ]),
    ).toThrow();
  });

  it("skips turn item types from a newer server in snapshots and turn-item events", () => {
    const decodeWireItems = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.Array(OrchestrationV2RpcSchemas.subscribeThread.output)),
    );
    const decodeHistoryPage = Schema.decodeUnknownSync(
      Schema.toCodecJson(OrchestrationV2ThreadHistoryPage),
    );
    const item = (id: string, type: string, extra: Record<string, unknown>) => ({
      id,
      type,
      threadId: "thread-1",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.formatIso(now),
      ...extra,
    });
    const known = item("item-known", "system_notice", { message: "Hello" });
    const future = item("item-future", "hologram", { beam: "ref-1" });
    const projected = (position: number, turnItem: { readonly id: string }) => ({
      position,
      visibility: "local",
      sourceThreadId: "thread-1",
      sourceItemId: turnItem.id,
      item: turnItem,
    });
    const projection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: "thread-1",
        projectId: "project-1",
        title: "Thread",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
        forkedFrom: null,
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
        archivedAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [future, known],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [projected(0, future), projected(1, known)],
      updatedAt: DateTime.formatIso(now),
    };
    const turnItemEvent = (sequence: number, payload: unknown) => ({
      kind: "event",
      sequence,
      event: {
        id: `event-${sequence}`,
        type: "turn-item.updated",
        threadId: "thread-1",
        occurredAt: DateTime.formatIso(now),
        payload,
      },
    });

    const [snapshot, futureEvent, knownEvent] = decodeWireItems([
      { kind: "snapshot", snapshotSequence: 1, projection },
      turnItemEvent(2, future),
      turnItemEvent(3, known),
    ]);

    expect(snapshot).toMatchObject({ kind: "snapshot" });
    if (snapshot?.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot.projection.turnItems.map((turnItem) => turnItem.id)).toEqual(["item-known"]);
    expect(snapshot.projection.visibleTurnItems.map((row) => row.item.id)).toEqual(["item-known"]);
    // The same snapshot with an ID table: refs resolve before unknown items are skipped.
    const tabled = (turnItem: { readonly id: string }, ref: number) => ({ ...turnItem, id: ref });
    const [tabledSnapshot] = decodeWireItems([
      {
        kind: "snapshot",
        snapshotSequence: 1,
        projection: {
          ...projection,
          turnItems: [tabled(future, 0), tabled(known, 1)],
          visibleTurnItems: [
            { ...projected(0, future), sourceItemId: 0, item: tabled(future, 0) },
            { ...projected(1, known), sourceItemId: 1, item: tabled(known, 1) },
          ],
        },
        ids: ["item-future", "item-known"],
      },
    ]);
    expect(tabledSnapshot).toEqual(snapshot);
    expect(futureEvent).toEqual({
      kind: "unknown-event",
      sequence: 2,
      eventType: "turn-item.updated",
    });
    expect(knownEvent).toMatchObject({
      kind: "event",
      event: { type: "turn-item.updated", payload: { id: "item-known", type: "system_notice" } },
    });
    expect(
      decodeHistoryPage({
        snapshotSequence: 1,
        items: [projected(0, future), projected(1, known)],
        nextCursor: null,
        hasMoreHistory: false,
      }).items.map((row) => row.item.id),
    ).toEqual(["item-known"]);

    const broken = item("item-broken", "system_notice", {});
    expect(() => decodeWireItems([turnItemEvent(4, broken)])).toThrow();
    expect(() =>
      decodeWireItems([
        {
          kind: "snapshot",
          snapshotSequence: 1,
          projection: { ...projection, turnItems: [broken] },
        },
      ]),
    ).toThrow();
  });

  it("decodes persisted capability snapshots that predate runtimePolicy", () => {
    const legacyCapabilities = {
      sessions: {
        supportsMultipleProviderThreadsPerSession: false,
        supportsModelSwitchInSession: false,
        supportsProviderSwitchingViaHandoff: true,
        supportsRuntimeModeSwitchInSession: false,
        pendingRequestsSurviveRestart: false,
      },
      threads: {
        canCreateEmptyThread: true,
        canReadThreadSnapshot: false,
        canRollbackThread: true,
        canForkThread: false,
        canForkFromTurn: false,
        canForkFromSubagentThread: false,
        exposesNativeThreadId: true,
      },
      turns: {
        exposesNativeTurnId: false,
        emitsTurnStarted: true,
        emitsTurnCompleted: true,
        supportsInterrupt: true,
        supportsActiveSteering: false,
        supportsSteeringByInterruptRestart: true,
        supportsQueuedMessages: true,
        terminalStatusQuality: "strong",
      },
      streaming: {
        streamsAssistantText: true,
        streamsReasoning: true,
        streamsToolOutput: true,
        streamsPlanText: false,
        emitsMessageCompleted: true,
      },
      tools: {
        exposesToolItemIds: true,
        emitsToolStarted: true,
        emitsToolCompleted: true,
        emitsToolOutput: true,
        supportsMcpTools: false,
        supportsDynamicToolCallbacks: false,
      },
      approvals: {
        supportsCommandApproval: true,
        supportsFileReadApproval: true,
        supportsFileChangeApproval: true,
        supportsApplyPatchApproval: false,
        approvalsHaveNativeRequestIds: false,
        approvalCallbacksAreLiveOnly: true,
        approvalsCanOriginateFromSubagents: false,
      },
      planning: {
        emitsPlanUpdated: true,
        emitsTodoList: true,
        emitsProposedPlan: false,
        supportsStructuredQuestions: true,
        planDeltasHaveItemIds: false,
      },
      subagents: {
        supportsSubagents: false,
        exposesSubagentThreadIds: false,
        emitsSubagentLifecycle: false,
        canWaitForSubagents: false,
        canCloseSubagents: false,
        canForkSubagentThread: false,
      },
      context: {
        acceptsSystemContext: false,
        acceptsDeveloperContext: false,
        acceptsSyntheticUserContext: true,
        canGenerateSummaries: true,
        canConsumeHandoffSummaries: true,
        supportsDeltaHandoff: true,
        supportsFullThreadHandoff: true,
        maxRecommendedHandoffChars: null,
      },
      checkpointing: {
        appCanCheckpointFilesystem: true,
        supportsNestedCheckpointScopes: true,
        providerCanRollbackConversation: true,
        providerRollbackReturnsSnapshot: true,
        providerCanReadConversationSnapshot: false,
      },
      identity: {
        nativeThreadIds: "strong",
        nativeTurnIds: "weak",
        nativeItemIds: "weak",
        nativeRequestIds: "weak",
      },
    };

    const decoded = decodeOrchestrationV2ProviderCapabilities(legacyCapabilities);
    expect(decoded.runtimePolicy).toEqual({ enforcement: "client-boundary" });

    const explicit = decodeOrchestrationV2ProviderCapabilities({
      ...legacyCapabilities,
      runtimePolicy: { enforcement: "native" },
    });
    expect(explicit.runtimePolicy).toEqual({ enforcement: "native" });
  });

  it("decodes command and domain event shapes for command-to-projection tests", () => {
    const command = decodeOrchestrationV2Command({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: "command-1",
      threadId: "thread-1",
      messageId: "message-1",
      text: "hello",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    const event = decodeOrchestrationV2DomainEvent({
      id: "event-1",
      type: "run.created",
      threadId: "thread-1",
      runId: "run-1",
      occurredAt: now,
      payload: {
        id: "run-1",
        threadId: "thread-1",
        ordinal: 1,
        providerInstanceId: "codex",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
        },
        providerThreadId: "provider-thread-1",
        userMessageId: "message-1",
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });

    expect(command.commandId).toBe(CommandId.make("command-1"));
    expect(event.id).toBe(EventId.make("event-1"));
    if (event.type !== "run.created") {
      throw new Error(`Expected run.created, received ${event.type}.`);
    }
    expect(event.payload.id).toBe(RunId.make("run-1"));
    expect(event.payload.memoryGrantCeiling).toBe("none");
  });

  it.each(["  indented prompt\n", "\n \t\n"])(
    "preserves workflow prompt and result %j in stored and wire JSON",
    (preview) => {
      const subagent = {
        ...decodeOrchestrationV2Subagent({
          id: "workflow-coordinator",
          threadId: "thread-1",
          runId: "run-1",
          parentNodeId: "node-root-1",
          origin: "provider_native",
          createdBy: "agent",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Run workflow",
          title: null,
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        }),
        workflow: {
          phases: [],
          agents: [
            {
              index: 1,
              label: "Member",
              state: "completed" as const,
              prompt: preview,
              result: preview,
            },
          ],
        },
      };
      const { workflow, ...coordinator } = subagent;
      const incoming = { ...encodeOrchestrationV2SubagentJson(coordinator), workflow };
      for (const codec of [
        OrchestrationV2SubagentJson,
        Schema.toCodecJson(OrchestrationV2Subagent),
      ]) {
        const encode = Schema.encodeSync(codec);
        const decode = Schema.decodeUnknownSync(codec);
        const json: unknown = JSON.parse(JSON.stringify(encode(subagent)));
        expect(json).toMatchObject({
          workflow: { agents: [{ prompt: preview, result: preview }] },
        });
        expect(decode(json).workflow?.agents[0]).toMatchObject({
          prompt: preview,
          result: preview,
        });
        expect(decode(incoming).workflow?.agents[0]).toMatchObject({
          prompt: preview,
          result: preview,
        });
      }
    },
  );

  it("decodes historical provider-thread JSON without pendingBackgroundTasks as empty roster", () => {
    const providerThread = decodeOrchestrationV2ProviderThreadJson({
      id: "provider-thread-1",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: "provider-session-1",
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: {
        driver: "claude",
        nativeId: "native-session-1",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    });

    expect(providerThread.pendingBackgroundTasks).toEqual([]);
    expect(providerThread.contextUsage).toBeNull();
    expect(providerThread.nativeMetadata).toBeNull();

    const runtimeThread = decodeOrchestrationV2ProviderThread({
      id: "provider-thread-2",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: null,
      appThreadId: "thread-2",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(runtimeThread.pendingBackgroundTasks).toEqual([]);
    expect(runtimeThread.contextUsage).toBeNull();
    expect(runtimeThread.nativeMetadata).toBeNull();
  });
});

describe("thread open stats", () => {
  it("reads a thread whose open stats this build cannot read, without them", () => {
    const shell = {
      id: "thread-test",
      projectId: "project-test",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: "thread-test", parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "mobile",
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    };
    const decode = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);
    const opens = { openedAt: 1, score: 1, picks: [{ query: "upl", at: 1 }] };
    expect(decode({ ...shell, opens }).opens).toEqual(opens);
    expect(decode({ ...shell, opens: { openedAt: "2026-10-01", score: 1 } }).opens).toBeNull();
  });
});

describe("background work kinds from older or newer servers", () => {
  const storedNotification = (source: unknown) => ({
    id: "notification",
    threadId: "parent",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-09-09T00:00:00.000Z",
    type: "notification",
    outcome: "completed",
    summary: "Background activity updated",
    source,
  });

  it("decodes notification sources stored before specific kinds existed", () => {
    const sourceOf = (source: unknown) => {
      const item = decodeOrchestrationV2TurnItemJson(storedNotification(source));
      return item.type === "notification" ? item.source : undefined;
    };
    expect(
      sourceOf({ kind: "background_task", nativeRef: { driver: "claude", nativeId: "task-1" } }),
    ).toEqual({ kind: "background_task" });
    expect(sourceOf({ kind: "background_command" })).toEqual({ kind: "command" });
    expect(sourceOf({ kind: "monitor" })).toEqual({ kind: "monitor" });
  });

  it("sends and stores sources that clients from before specific kinds still decode", () => {
    const PreSpecificKindsNotification = Schema.Struct({
      type: Schema.Literal("notification"),
      source: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("delegated_task"), taskIds: Schema.Array(NodeId) }),
        Schema.Struct({
          kind: Schema.Literals(["background_task", "background_command", "monitor"]),
          nativeRef: Schema.optional(Schema.Unknown),
        }),
      ]),
      outcome: Schema.Literals(["completed", "failed", "cancelled", "updated", "unknown"]),
      summary: Schema.String,
      detail: Schema.optional(Schema.String),
    });
    const decodePreSpecificKinds = Schema.decodeUnknownSync(PreSpecificKindsNotification);
    const sendOverWire = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));
    const cases = [
      [{ kind: "subagent", childThreadId: "child" }, { kind: "background_task" }],
      [{ kind: "subagent" }, { kind: "background_task" }],
      [{ kind: "command" }, { kind: "background_command" }],
      [{ kind: "monitor" }, { kind: "monitor" }],
      [{ kind: "background_task" }, { kind: "background_task" }],
      [
        { kind: "delegated_task", taskIds: ["task-1"], childThreadId: "child" },
        { kind: "delegated_task", taskIds: ["task-1"] },
      ],
    ] as const;
    for (const [source, preSpecificKindsSource] of cases) {
      const item = decodeOrchestrationV2TurnItemJson(storedNotification(source));
      for (const encoded of [encodeOrchestrationV2TurnItemJson(item), sendOverWire(item)]) {
        expect(decodePreSpecificKinds(encoded).source).toEqual(preSpecificKindsSource);
        expect(decodeOrchestrationV2TurnItemJson(encoded)).toEqual(item);
      }
      expect(item).toMatchObject({ source });
    }
  });

  it("decodes a notification source kind from a newer server as generic background work", () => {
    const item = decodeOrchestrationV2TurnItemJson(
      storedNotification({ kind: "workflow", workflowId: "wf-1" }),
    );
    expect(item).toMatchObject({ type: "notification", source: { kind: "background_task" } });
  });

  it("decodes rosters stored before kinds existed, and kinds from a newer server, as generic tasks", () => {
    const providerThread = decodeOrchestrationV2ProviderThreadJson({
      id: "provider-thread-1",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: null,
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      pendingBackgroundTasks: [
        { taskId: "bg-1", description: "Background sleep", taskType: "local_bash" },
        { taskId: "bg-2" },
        { taskId: "bg-3", description: "Nightly", kind: "workflow", schedule: "0 3 * * *" },
        { taskId: "bg-4", description: "npm test", kind: "command" },
        { taskId: "bg-5", kind: "subagent", childThreadId: "thread-child" },
        { taskId: "bg-6", kind: "subagent", providerInstanceId: "claudeAgent" },
      ],
    });
    expect(providerThread.pendingBackgroundTasks).toEqual([
      { taskId: "bg-1", description: "Background sleep", kind: "background_task" },
      { taskId: "bg-2", kind: "background_task" },
      { taskId: "bg-3", description: "Nightly", kind: "background_task" },
      { taskId: "bg-4", description: "npm test", kind: "command" },
      { taskId: "bg-5", kind: "subagent", childThreadId: "thread-child" },
      { taskId: "bg-6", kind: "subagent", providerInstanceId: "claudeAgent" },
    ]);
    const encoded = encodeOrchestrationV2ProviderThreadJson(providerThread).pendingBackgroundTasks;
    expect(encoded).toEqual(providerThread.pendingBackgroundTasks);
    const decodePreKindsRoster = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          taskId: TrimmedNonEmptyString,
          description: Schema.optional(TrimmedNonEmptyString),
          taskType: Schema.optional(TrimmedNonEmptyString),
        }),
      ),
    );
    expect(decodePreKindsRoster(encoded).map((task) => task.taskId)).toEqual([
      "bg-1",
      "bg-2",
      "bg-3",
      "bg-4",
      "bg-5",
      "bg-6",
    ]);
    expect(() =>
      decodeOrchestrationV2ProviderThreadJson({
        ...encodeOrchestrationV2ProviderThreadJson(providerThread),
        pendingBackgroundTasks: [{ taskId: "", kind: "command" }],
      }),
    ).toThrow();
  });
});

describe("latestProviderTurnForAttempt", () => {
  it("returns the attempt's highest-ordinal turn, as a Codex goal run spans several", () => {
    const turns = [
      { id: "first", runAttemptId: RunAttemptId.make("goal-attempt"), ordinal: 3 },
      { id: "other", runAttemptId: RunAttemptId.make("other-attempt"), ordinal: 9 },
      { id: "last", runAttemptId: RunAttemptId.make("goal-attempt"), ordinal: 5 },
      { id: "subagent", runAttemptId: null, ordinal: 7 },
    ];
    expect(latestProviderTurnForAttempt(turns, RunAttemptId.make("goal-attempt"))?.id).toBe("last");
    expect(latestProviderTurnForAttempt(turns, null)).toBeUndefined();
  });
});

// The notification schema clients shipped with before task chips.
const PreChipNotification = Schema.Struct({
  type: Schema.Literal("notification"),
  source: Schema.Struct({ kind: Schema.Literal("background_task") }),
  outcome: Schema.Literals(["completed", "failed", "cancelled", "updated", "unknown"]),
  summary: Schema.String,
  detail: Schema.optional(Schema.String),
});
const decodePreChipNotification = Schema.decodeUnknownSync(PreChipNotification);

describe("GOAT bot channel metadata", () => {
  const notificationItem = {
    id: "chip:task-1",
    threadId: "goat-bot",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 3,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-10-12T00:00:05.000Z",
    type: "notification",
    source: { kind: "background_task" },
    outcome: "updated",
    summary: "Re-verify the Opus 5.5 call",
  };
  const chip = {
    taskId: "task-1",
    conversationId: "conv-1",
    taskVersion: 3,
    title: "Re-verify the Opus 5.5 call",
    status: "running",
    originKind: "slack",
    requesterLabel: "Jun",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:05.000Z",
    worker: { environmentId: "env-1", threadId: "worker-thread" },
    openQuestionCount: 0,
  };

  it("round-trips a task chip on a notification item", () => {
    const item = decodeOrchestrationV2TurnItemJson({ ...notificationItem, ledgerTask: chip });
    expect(item).toMatchObject({ type: "notification", ledgerTask: chip });
    expect(decodeOrchestrationV2TurnItemJson(encodeOrchestrationV2TurnItemJson(item))).toEqual(
      item,
    );
  });

  it("is ignored by clients whose notification schema predates chips", () => {
    const item = decodeOrchestrationV2TurnItemJson({ ...notificationItem, ledgerTask: chip });
    const decoded = decodePreChipNotification(encodeOrchestrationV2TurnItemJson(item));
    expect(decoded).toEqual({
      type: "notification",
      source: { kind: "background_task" },
      outcome: "updated",
      summary: "Re-verify the Opus 5.5 call",
    });
  });

  it("drops a chip this build cannot read and keeps the notification", () => {
    const item = decodeOrchestrationV2TurnItemJson({
      ...notificationItem,
      ledgerTask: { ...chip, status: "paused_by_newer_server" },
    });
    expect(item).toMatchObject({ type: "notification", summary: "Re-verify the Opus 5.5 call" });
    expect(item.type === "notification" ? item.ledgerTask : "not a notification").toBeUndefined();
    expect(decodeOrchestrationV2TurnItemJson(notificationItem)).not.toHaveProperty("ledgerTask");
  });

  it("round-trips channel metadata on runless bot messages and decodes messages without it", () => {
    const base = { ...notificationItem, id: "reply:input-1", ordinal: 4 };
    delete (base as { source?: unknown }).source;
    delete (base as { outcome?: unknown }).outcome;
    delete (base as { summary?: unknown }).summary;
    const meta = {
      conversationId: "conv-1",
      originKind: "goat",
      kind: "receipt",
      inputId: "input-2",
      inReplyToInputId: "input-1",
      readAt: "2026-10-12T00:00:01.000Z",
    };
    const assistant = decodeOrchestrationV2TurnItemJson({
      ...base,
      type: "assistant_message",
      messageId: "reply:input-1",
      text: "On it.",
      streaming: false,
      channel: meta,
    });
    expect(assistant).toMatchObject({ runId: null, channel: meta });
    expect(decodeOrchestrationV2TurnItemJson(encodeOrchestrationV2TurnItemJson(assistant))).toEqual(
      assistant,
    );
    const user = decodeOrchestrationV2TurnItemJson({
      ...base,
      id: "input:input-1",
      type: "user_message",
      messageId: "input:input-1",
      createdBy: "user",
      creationSource: "web",
      inputIntent: "turn_start",
      text: "Re-verify the Opus 5.5 call",
      attachments: [],
      channel: {
        conversationId: "conv-1",
        originKind: "goat",
        kind: "inbound",
        inputId: "input-1",
      },
    });
    expect(user).toMatchObject({ channel: { kind: "inbound" } });
    const { channel: _channel, ...withoutChannel } = encodeOrchestrationV2TurnItemJson(
      user,
    ) as Record<string, unknown>;
    expect(decodeOrchestrationV2TurnItemJson(withoutChannel)).not.toHaveProperty("channel");
    // Metadata with a kind from a newer server drops; the message itself still decodes.
    const newerKind = decodeOrchestrationV2TurnItemJson({
      ...withoutChannel,
      channel: { conversationId: "conv-1", originKind: "goat", kind: "typing" },
    });
    expect(newerKind).toMatchObject({ type: "user_message", text: "Re-verify the Opus 5.5 call" });
    expect(newerKind.type === "user_message" ? newerKind.channel : "wrong type").toBeUndefined();
  });
});

it("roundtrips remote subagent addressing without exposing internal task commands", () => {
  const task = decodeOrchestrationV2Subagent({
    id: "remote-task",
    threadId: "parent",
    runId: "parent-run",
    parentNodeId: "parent-root",
    origin: "app_owned",
    createdBy: "agent",
    driver: "claude",
    providerInstanceId: "remote-provider",
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    remote: { host: "box", threadId: "remote-child", correlationId: "rr-A" },
    prompt: "Inspect",
    title: null,
    model: "remote-model",
    status: "running",
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  });
  const encoded = encodeOrchestrationV2Subagent(task);
  expect(decodeOrchestrationV2Subagent(encoded).remote).toEqual(task.remote);
  for (const type of [
    "delegated_task.remote.register",
    "delegated_task.remote.progress",
    "delegated_task.remote.result",
  ]) {
    expect(() =>
      decodeOrchestrationV2Command({
        type,
        commandId: "forged",
        parentThreadId: "parent",
        taskId: "remote-task",
        correlationId: "rr-A",
        status: "completed",
        summary: "forged",
      }),
    ).toThrow();
  }
});

describe("question foundations", () => {
  it("round-trips launcher on thread payloads and accepts legacy absence", () => {
    const input = emptyThreadProjection().thread;
    const decode = Schema.decodeUnknownSync(OrchestrationV2AppThread);
    const encodeJson = Schema.encodeSync(OrchestrationV2AppThreadJson);
    const decodeJson = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
    for (const via of [
      "thread_launch",
      "create_threads",
      "ssh_thread_launch",
      "delegate_task",
    ] as const) {
      const launcher = {
        kind: "launch" as const,
        environmentLabel: null,
        threadTitle: null,
        threadId: ThreadId.make("caller"),
        environmentId: null,
        via,
      };
      const thread = decode({ ...input, launchedBy: launcher });
      expect(decodeJson(encodeJson(thread)).launchedBy).toEqual(launcher);
    }
    expect(decodeJson(encodeJson(decode(input))).launchedBy).toBeUndefined();
  });

  it("requires every agent responder member and bounds reason", () => {
    const decode = Schema.decodeUnknownSync(UserInputRespondedBy);
    const reason = Schema.decodeUnknownSync(UserInputResponseReason);
    const agent = {
      type: "agent" as const,
      threadId: ThreadId.make("caller"),
      environmentId: null,
      title: null,
      reason: "R",
    };
    expect(decode({ type: "user" })).toEqual({ type: "user" });
    expect(decode(agent)).toEqual(agent);
    expect(reason("R".repeat(2000))).toHaveLength(2000);
    expect(() => reason("")).toThrow();
    expect(() => reason("   ")).toThrow();
    expect(reason("  R  ")).toBe("  R  ");
    expect(decode({ type: "client", reason: "R" })).toEqual({ type: "client", reason: "R" });
    expect(() => reason("R".repeat(2001))).toThrow();
    for (const key of ["threadId", "environmentId", "title", "reason"] as const) {
      const incomplete: Record<string, unknown> = { ...agent };
      delete incomplete[key];
      expect(() => decode(incomplete)).toThrow();
    }
    const outsideEnvironment = EnvironmentId.make("origin");
    expect(decode({ ...agent, environmentId: outsideEnvironment })).toEqual({
      ...agent,
      environmentId: outsideEnvironment,
    });
  });

  it("accepts unknown answer provenance and preserves recorded agent metadata", () => {
    const decode = Schema.decodeUnknownSync(UserInputAttachmentAnswerPayload);
    const old = {
      requestId: "request",
      answers: { q: "  Exact option  " },
      attachmentsByQuestionId: {},
    };
    expect(decode(old).respondedBy).toBeUndefined();
    const respondedBy = {
      type: "agent" as const,
      threadId: ThreadId.make("caller"),
      environmentId: null,
      title: "Coordinator",
      reason: "Matches the brief",
    };
    expect(decode({ ...old, respondedBy })).toEqual({ ...old, respondedBy });
  });

  it("round-trips question source and rejects malformed known questions", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2NotificationSource);
    const encode = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2NotificationSource));
    const source = {
      kind: "question" as const,
      threadId: ThreadId.make("asking"),
      requestId: RuntimeRequestId.make("request"),
      humanRequired: true,
    };
    expect(decode(encode(source))).toEqual(source);
    for (const key of ["threadId", "requestId", "humanRequired"] as const) {
      const incomplete: Record<string, unknown> = { ...source };
      delete incomplete[key];
      expect(() => decode(incomplete)).toThrow();
    }
    expect(decode({ kind: "future-question-kind" })).toEqual({ kind: "background_task" });
  });
});

const encodeShellJson = Schema.encodeSync(OrchestrationV2ThreadShellJson);
const decodeShellJson = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);
const decodeRuntimeRequestJson = Schema.decodeUnknownSync(OrchestrationV2RuntimeRequestJson);
const encodeRuntimeRequestJson = Schema.encodeSync(OrchestrationV2RuntimeRequestJson);

it("carries launcher through create commands and shell JSON", () => {
  for (const via of [
    "thread_launch",
    "create_threads",
    "ssh_thread_launch",
    "delegate_task",
  ] as const) {
    for (const environmentId of [null, EnvironmentId.make("origin")]) {
      const launcher = {
        kind: "launch" as const,
        environmentLabel: null,
        threadTitle: null,
        threadId: ThreadId.make("caller"),
        environmentId,
        via,
      };
      const command = {
        type: "thread.create",
        commandId: "create",
        createdBy: "agent",
        creationSource: "mcp",
        threadId: "child",
        projectId: "project",
        title: "Child",
        modelSelection: { instanceId: "codex", model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        launchedBy: launcher,
      };
      expect(decodeOrchestrationV2Command(command)).toMatchObject({ launchedBy: launcher });
      for (const key of [
        "kind",
        "threadId",
        "environmentId",
        "environmentLabel",
        "threadTitle",
      ] as const) {
        const incomplete = { ...launcher };
        delete (incomplete as Record<string, unknown>)[key];
        expect(() =>
          decodeOrchestrationV2Command({ ...command, launchedBy: incomplete }),
        ).toThrow();
      }
      const shell = decodeOrchestrationV2ThreadShell({
        launchedBy: launcher,
        createdBy: "user",
        creationSource: "web",
        id: "thread-1",
        projectId: "project-1",
        title: "Thread",
        providerInstanceId: "claudeAgent",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: "thread-1",
        },
        forkedFrom: null,
        activeProviderThreadId: "provider-thread-1",
        latestRunId: "run-1",
        activeRunId: null,
        status: "completed",
        pendingRuntimeRequest: null,
        latestVisibleMessage: null,
        latestUserMessageAt: null,
        hasActionableProposedPlan: false,
        itemCount: 0,
        visibleItemCount: 0,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
      });
      const encoded = encodeShellJson(shell);
      expect(decodeShellJson(encoded).launchedBy).toEqual(launcher);
    }
  }
});
it("round-trips responder metadata in resolved requests, commands and history", () => {
  for (const respondedBy of [
    undefined,
    { type: "user" as const },
    { type: "client" as const, reason: "R" },
    ...[undefined, false, true].map((relayedFromUser) => ({
      type: "agent" as const,
      threadId: ThreadId.make("caller"),
      environmentId: null,
      title: null,
      reason: "  R  ",
      ...(relayedFromUser === undefined ? {} : { relayedFromUser }),
    })),
  ]) {
    const metadata = respondedBy === undefined ? {} : { respondedBy };
    const request = decodeRuntimeRequestJson({
      id: "request",
      nodeId: "node",
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "resolved",
      responseCapability: { type: "message" },
      createdAt: DateTime.formatIso(now),
      resolvedAt: DateTime.formatIso(now),
      answers: { q: "  Exact  " },
      ...metadata,
    });
    expect(decodeRuntimeRequestJson(encodeRuntimeRequestJson(request))).toEqual(request);
    const event = decodeOrchestrationV2DomainEvent({
      id: "answer-event",
      type: "runtime-request.updated",
      threadId: "thread",
      occurredAt: now,
      payload: request,
    });
    expect(event.payload).toEqual(request);
    if (respondedBy?.type === "agent" && respondedBy.relayedFromUser === undefined) {
      expect(describeUserInputResponder({ respondedBy })).toBe('orchestrator "caller"');
      expect(request.respondedBy).not.toHaveProperty("relayedFromUser");
    }
    expect(
      decodeOrchestrationV2Command({
        type: "runtime-request.respond",
        commandId: "answer",
        threadId: "thread",
        requestId: "request",
        answers: request.answers,
        ...metadata,
      }),
    ).toMatchObject(metadata);
    const item = decodeOrchestrationV2TurnItem({
      id: "item",
      type: "user_input_request",
      threadId: "thread",
      runId: null,
      nodeId: "node",
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      requestId: "request",
      questions: [],
      questionAnswer: {
        requestId: "request",
        answers: request.answers,
        attachmentsByQuestionId: {},
        ...metadata,
      },
    });
    expect(decodeOrchestrationV2TurnItemJson(encodeOrchestrationV2TurnItemJson(item))).toEqual(
      item,
    );
  }
});
it("counts human answers from direct users and agent relay claims only", () => {
  const decode = Schema.decodeUnknownSync(UserInputRespondedBy);
  const agent = {
    type: "agent",
    threadId: "caller",
    environmentId: null,
    title: "Coordinator",
    reason: "The user decided this.",
  };
  const responders = [
    { type: "user" },
    { ...agent, relayedFromUser: true },
    { ...agent, environmentId: "foreign", relayedFromUser: true },
    agent,
    { ...agent, relayedFromUser: false },
    { type: "client", reason: "The user decided this." },
  ].map((responder) => decode(responder));
  expect(
    responders.filter(
      (responder) =>
        responder.type === "user" ||
        (responder.type === "agent" && responder.relayedFromUser === true),
    ),
  ).toHaveLength(3);
  expect(() => decode({ ...agent, relayedFromUser: "true" })).toThrow();
});
it("describes responders and terminal outcomes truthfully", () => {
  expect(describeUserInputResponder({})).toBe("another responder");
  expect(
    describeUserInputResponder({
      respondedBy: { type: "user" },
      decision: "cancel",
      status: "resolved",
    }),
  ).toBe("dismissed by the user");
  expect(describeUserInputResponder({ decision: "cancel", status: "resolved" })).toBe(
    "closed when its thread stopped or settled",
  );
  expect(describeUserInputResponder({ status: "expired" })).toBe("expired");
  expect(describeUserInputResponder({ status: "cancelled" })).toBe("cancelled");
});

function encodedKind(member: Schema.Top): string {
  const encoded = SchemaAST.toEncoded(member.ast);
  const kind = SchemaAST.isObjects(encoded)
    ? encoded.propertySignatures.find((property) => property.name === "kind")?.type
    : undefined;
  if (kind !== undefined && SchemaAST.isLiteral(kind) && typeof kind.literal === "string") {
    return kind.literal;
  }
  throw new Error("Each member of a kind union needs a literal string `kind`.");
}

/**
 * A union tagged by `kind` that tolerates kinds this build does not know.
 * After the known members comes a decode-only arm: an object with an unknown
 * `kind`, or none, decodes through `fallback` to a known member instead of
 * failing, so a newer server can add kinds without breaking older clients and
 * rows written before a kind existed still load. `unknown` builds that arm's
 * input around the given `kind` field. A known kind whose fields do not decode
 * still fails. Kinds are the encoded ones, which a member may rename on decode.
 * The arm never encodes; values always match a known member first.
 */
function kindUnionWithFallback<
  const Members extends ReadonlyArray<Schema.Top & { readonly Encoded: { readonly kind: string } }>,
  Unknown extends Schema.Top,
>(
  members: Members,
  unknown: (kind: Schema.optional<Schema.String>) => Unknown,
  fallback: (value: Unknown["Type"]) => Schema.Union<Members>["Encoded"],
) {
  const knownKinds: ReadonlySet<string> = new Set(members.map(encodedKind));
  const unknownKind = unknown(
    Schema.optional(
      Schema.String.check(
        Schema.makeFilter(
          (kind: string) => !knownKinds.has(kind) || "A known kind must decode in full.",
        ),
      ),
    ),
  ).pipe(
    Schema.decodeTo(Schema.Union(members), {
      decode: SchemaGetter.transform(fallback),
      encode: SchemaGetter.forbidden(() => "Unknown kinds are decode-only."),
    }),
  );
  // Members are tried in order, so the fallback must come last.
  return Schema.Union([...members, unknownKind]);
}

const SubagentNotificationSource = Schema.Struct({
  kind: Schema.Literal("subagent"),
  /** The subagent's own thread, when the notification reports one subagent. */
  childThreadId: Schema.optional(ThreadId),
});
const CommandNotificationSource = Schema.Struct({ kind: Schema.Literal("command") });

/**
 * What a notification reports on. Several pieces of work of one kind share
 * that kind; mixed or unnamed work is `background_task`.
 *
 * Sources are stored and sent in the shape clients before `subagent` and
 * `command` existed decode, since they reject a kind they do not know: a
 * command is `background_command`, and a subagent is `background_task` with
 * `work: "subagent"`, a field those clients ignore. Encoding picks the first
 * member that fits, so those come first. The plain `subagent` and `command`
 * members after them decode values that were already decoded once.
 */
const PreQuestionNotificationSource = kindUnionWithFallback(
  [
    Schema.Struct({
      kind: Schema.Literal("delegated_task"),
      taskIds: Schema.Array(NodeId),
      /** The task's own thread, when the notification reports one task. */
      childThreadId: Schema.optional(ThreadId),
    }),
    Schema.Struct({
      kind: Schema.Literal("background_task"),
      work: Schema.Literal("subagent"),
      childThreadId: Schema.optional(ThreadId),
    }).pipe(
      Schema.decodeTo(Schema.toType(SubagentNotificationSource), {
        decode: SchemaGetter.transform(({ childThreadId }) =>
          childThreadId === undefined
            ? { kind: "subagent" as const }
            : { kind: "subagent" as const, childThreadId },
        ),
        encode: SchemaGetter.transform(({ childThreadId }) => ({
          kind: "background_task" as const,
          work: "subagent" as const,
          ...(childThreadId === undefined ? {} : { childThreadId }),
        })),
      }),
    ),
    Schema.Struct({ kind: Schema.Literal("background_command").transform("command") }),
    SubagentNotificationSource,
    CommandNotificationSource,
    Schema.Struct({ kind: Schema.Literal("monitor") }),
    Schema.Struct({ kind: Schema.Literal("background_task") }),
    /** T3 Code itself, such as a restart continuing an interrupted turn. */
    Schema.Struct({ kind: Schema.Literal("system") }),
  ],
  (kind) => Schema.Struct({ kind }),
  () => ({ kind: "background_task" }),
);

const encodeNotificationSourceJson = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2NotificationSource),
);
const decodePreQuestionSource = Schema.decodeUnknownSync(PreQuestionNotificationSource);
const decodeNotificationSource = Schema.decodeUnknownSync(OrchestrationV2NotificationSource);

it("lets pre-question clients fall back without losing new-client identity", () => {
  const source = {
    kind: "question" as const,
    threadId: ThreadId.make("asking"),
    requestId: RuntimeRequestId.make("request"),
    humanRequired: false,
  };
  const wire = encodeNotificationSourceJson(source);
  expect(decodePreQuestionSource(wire)).toEqual({
    kind: "background_task",
  });
  expect(decodeNotificationSource(wire)).toEqual(source);
});

it("round-trips the local and remote question escalation seam", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationV2QuestionEscalation);
  const encode = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2QuestionEscalation));
  const decodeJson = Schema.decodeUnknownSync(
    Schema.fromJsonString(OrchestrationV2QuestionEscalation),
  );
  for (const environmentId of [null, EnvironmentId.make("origin")]) {
    const payload = {
      environmentId,
      threadId: ThreadId.make("asking"),
      title: "Question source",
      requestId: RuntimeRequestId.make("request:color"),
      questions: [
        {
          id: "color",
          header: "Color",
          question: "Which color?",
          options: [{ label: "Blue", description: "Use blue" }],
          multiSelect: false,
        },
      ],
      deadline: null,
      humanRequired: environmentId !== null,
      answerWith: "goat_pending_request_respond",
    };
    const question = decode(payload);
    expect(decodeJson(encode(question))).toEqual(payload);
    expect(() => decode({ ...payload, deadline: "tomorrow" })).toThrow();
    expect(() => decode({ ...payload, answerWith: "other_tool" })).toThrow();
    const { environmentId: _environmentId, ...missingEnvironment } = payload;
    expect(() => decode(missingEnvironment)).toThrow();
  }
});
it("round-trips resolution provenance through the question resolution seam", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationV2QuestionResolution);
  const encode = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2QuestionResolution));
  const decodeJson = Schema.decodeUnknownSync(
    Schema.fromJsonString(OrchestrationV2QuestionResolution),
  );
  for (const respondedBy of [
    undefined,
    { type: "user" },
    { type: "client", reason: "Client answer" },
    {
      type: "agent",
      threadId: ThreadId.make("launcher"),
      environmentId: EnvironmentId.make("remote"),
      title: "Launcher",
      reason: "Decision",
    },
  ]) {
    const payload = {
      environmentId: null,
      threadId: ThreadId.make("asking"),
      requestId: RuntimeRequestId.make("request"),
      resolvedAt: "2026-10-12T00:00:00.000Z",
      ...(respondedBy === undefined ? {} : { respondedBy }),
    };
    expect(decodeJson(encode(decode(payload)))).toEqual(payload);
  }
});

describe("GOAT bot conversation messages", () => {
  const decodeMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessage);
  const encodeMessageJson = Schema.encodeSync(OrchestrationV2ConversationMessageJson);
  const decodeMessageJson = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson);
  const message = {
    createdBy: "agent",
    creationSource: "server",
    id: "reply:input-1",
    threadId: "goat-bot",
    runId: null,
    nodeId: null,
    role: "assistant",
    text: "On it.",
    attachments: [],
    streaming: false,
    createdAt: DateTime.makeUnsafe("2026-10-12T00:00:01Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-12T00:00:01Z"),
  };

  it("round-trips channel metadata with native dates and a string read time", () => {
    const meta = {
      conversationId: "conv-1",
      originKind: "goat",
      kind: "receipt",
      inReplyToInputId: "input-1",
      readAt: "2026-10-12T00:00:00.500Z",
    };
    const native = decodeMessage({ ...message, channel: meta });
    const wire = encodeMessageJson(native);
    expect(wire).toMatchObject({ createdAt: "2026-10-12T00:00:01.000Z", channel: meta });
    expect(decodeMessageJson(wire)).toEqual(native);
  });

  it("decodes messages stored before channel metadata existed", () => {
    const decoded = decodeMessageJson(encodeMessageJson(decodeMessage(message)));
    expect(decoded).not.toHaveProperty("channel");
    expect(decoded).toMatchObject({ role: "assistant", text: "On it." });
  });
});

const memoryLegacyCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: true,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
};

describe("memory provider capability replay", () => {
  it("replays provider capabilities without memory", () => {
    expect(
      decodeOrchestrationV2ProviderCapabilities(memoryLegacyCapabilities).memory,
    ).toBeUndefined();
  });
  it("keeps snapshot MCP and generation capabilities independent", () => {
    for (const key of ["snapshot", "mcp", "resolveMemoryConflict", "generateMemorySummary"]) {
      const memory = {
        snapshot: false,
        mcp: false,
        resolveMemoryConflict: false,
        generateMemorySummary: false,
        [key]: true,
      };
      expect(
        decodeOrchestrationV2ProviderCapabilities({ ...memoryLegacyCapabilities, memory }).memory,
      ).toEqual(memory);
    }
  });
});

describe("WP4 task ceiling propagation codecs", () => {
  const delegate = {
    type: "delegated_task.request",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: "delegate",
    parentThreadId: "parent",
    parentRunId: "run",
    parentNodeId: "node",
    task: "Synthetic task",
    modelSelection: { instanceId: "codex", model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
  };
  it("defaults legacy commands to none and preserves explicit ceiling", () => {
    const legacy = decodeOrchestrationV2Command(delegate);
    expect(legacy).toMatchObject({ memoryGrantCeiling: "none" });
    expect(legacy).not.toHaveProperty("role");
    expect(legacy).not.toHaveProperty("parentModelSelection");
    expect(
      decodeOrchestrationV2Command({
        ...delegate,
        role: "review",
        parentModelSelection: { instanceId: "author", model: "author-model" },
      }),
    ).toMatchObject({
      role: "review",
      parentModelSelection: { instanceId: "author", model: "author-model" },
    });

    for (const memoryGrantCeiling of ["none", "read", "read_write"])
      expect(decodeOrchestrationV2Command({ ...delegate, memoryGrantCeiling })).toMatchObject({
        memoryGrantCeiling,
      });
    expect(() =>
      decodeOrchestrationV2Command({ ...delegate, memoryGrantCeiling: "write" }),
    ).toThrow();
  });
  it("preserves persisted child metadata through JSON and legacy restart", () => {
    const child = {
      id: "child",
      threadId: "parent",
      runId: "run",
      parentNodeId: "node",
      origin: "app_owned",
      createdBy: "agent",
      driver: "codex",
      providerInstanceId: "codex",
      providerThreadId: null,
      childThreadId: "child-thread",
      nativeTaskRef: null,
      prompt: "Synthetic task",
      title: null,
      model: null,
      status: "pending",
      result: null,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    };
    expect(decodeOrchestrationV2Subagent(child)).toMatchObject({ memoryGrantCeiling: "none" });
    const legacyTask = decodeOrchestrationV2Subagent(child);
    expect(legacyTask).not.toHaveProperty("role");
    expect(legacyTask).not.toHaveProperty("parentModelSelection");
    expect(legacyTask).not.toHaveProperty("reviewLedger");
    const metadata = {
      role: "review",
      modelSelection: { instanceId: "reviewer", model: "reviewer-model" },
      parentModelSelection: { instanceId: "author", model: "author-model" },
    };
    const reviewLedger = [
      {
        kind: "decision",
        entryId: "entry:1",
        findingId: "finding:1",
        severity: "high",
        cites: "a.ts:10",
        summary: "Verify the guard",
        decision: "rebutted",
        evidence: { kind: "test", ref: "guard.test.ts", exitCode: 0 },
        recordedAt: "2026-10-16T00:00:00.000Z",
        recordedByRunId: "run",
      },
      {
        kind: "outcome",
        entryId: "entry:2",
        findingId: "finding:1",
        outcome: "later_confirmed",
        link: { kind: "test", ref: "failure.test.ts" },
        recordedAt: "2026-10-17T00:00:00.000Z",
        recordedByRunId: null,
      },
    ];
    const review = decodeOrchestrationV2Subagent({ ...child, ...metadata, reviewLedger });
    const reviewJson = JSON.parse(JSON.stringify(encodeOrchestrationV2SubagentJson(review)));
    expect(decodeOrchestrationV2SubagentJson(reviewJson)).toMatchObject(metadata);
    expect(decodeOrchestrationV2SubagentJson(reviewJson).reviewLedger).toEqual(reviewLedger);
    expect(() => decodeOrchestrationV2Subagent({ ...child, role: "invalid" })).toThrow();

    expect(decodeOrchestrationV2Subagent(child)).not.toHaveProperty("currentMemoryAccess");
    const assessment = { access: "none", reason: "environment_off" } as const;
    expect(
      encodeOrchestrationV2SubagentJson(
        decodeOrchestrationV2Subagent({ ...child, currentMemoryAccess: assessment }),
      ),
    ).toHaveProperty("currentMemoryAccess", assessment);
    expect(
      encodeOrchestrationV2SubagentJson(decodeOrchestrationV2Subagent(child)),
    ).not.toHaveProperty("memoryGrantCeiling");
    for (const memoryGrantCeiling of ["none", "read", "read_write"] as const) {
      const current = decodeOrchestrationV2Subagent({ ...child, memoryGrantCeiling });
      const json = JSON.parse(JSON.stringify(encodeOrchestrationV2SubagentJson(current)));
      if (memoryGrantCeiling === "none") {
        expect(json).not.toHaveProperty("memoryGrantCeiling");
      } else {
        expect(json).toHaveProperty("memoryGrantCeiling", memoryGrantCeiling);
      }
      expect(decodeOrchestrationV2SubagentJson(json)).toMatchObject({
        memoryGrantCeiling,
      });
    }
  });
});

const decodeMemoryRun = Schema.decodeUnknownSync(OrchestrationV2RunJson);
const encodeMemoryRun = Schema.encodeSync(OrchestrationV2RunJson);
it("round-trips usage-limit run ancestry and omits absent ancestry on the wire", () => {
  const legacy = {
    id: "run-memory-contract",
    threadId: "thread-memory-contract",
    ordinal: 1,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "test" },
    providerThreadId: null,
    userMessageId: "message-memory-contract",
    rootNodeId: null,
    activeAttemptId: null,
    status: "starting",
    requestedAt: "2026-10-15T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  expect(encodeMemoryRun(decodeMemoryRun(legacy))).not.toHaveProperty(
    "usageLimitContinuationOfRunId",
  );
  expect(encodeMemoryRun(decodeMemoryRun(legacy))).not.toHaveProperty("currentMemoryAccess");
  const assessment = { access: "read", reason: "read_only_destination" } as const;
  expect(
    encodeMemoryRun(decodeMemoryRun({ ...legacy, currentMemoryAccess: assessment })),
  ).toHaveProperty("currentMemoryAccess", assessment);
  const continuation = { ...legacy, usageLimitContinuationOfRunId: "run-original" };
  expect(encodeMemoryRun(decodeMemoryRun(continuation))).toEqual(continuation);
});

it("decodes review ledger append commands and refuses empty batches", () => {
  const command = {
    type: "delegated_task.review-ledger.append",
    commandId: "record-review",
    parentThreadId: "parent",
    taskId: "review",
    entries: [
      { kind: "outcome", findingId: "finding", link: { kind: "test", ref: "failing.test.ts" } },
    ],
  };
  expect(decodeOrchestrationV2Command(command)).toEqual(command);
  expect(() => decodeOrchestrationV2Command({ ...command, entries: [] })).toThrow();
});

const decodeOrchestrationV2Command = Schema.decodeUnknownSync(OrchestrationV2Command);

function emptyThreadProjection() {
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
}

const decodeOrchestrationV2ThreadShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);

const decodeOrchestrationV2TurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
