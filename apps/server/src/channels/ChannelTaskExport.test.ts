import { assert, describe, it } from "@effect/vitest";
import {
  ChannelTaskEventId,
  CommandId,
  EventId,
  ThreadId,
  ChannelTaskExportRow,
  ChannelTaskLedgerExportRow,
  MemoryRevisionId,
  MemorySpaceId,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2StoredEvent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as MemoryStore from "../memory/MemoryStore.ts";
import * as Settings from "../serverSettings.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelLayers from "./ChannelLayers.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import {
  makeHarness,
  setupBot,
  goatInput,
  rpcContext,
  onlyTask,
  environmentId,
  scratchProjectId,
  modelSelection,
} from "./testkit/ChannelHarness.ts";
import * as ChannelTaskExport from "./ChannelTaskExport.ts";
import { answerForwardIdsFor, taskEventIdFor } from "./channelIds.ts";

const at = DateTime.makeUnsafe("2026-10-17T01:00:00.000Z");
const decodeRequest = Schema.decodeUnknownSync(OrchestrationV2RuntimeRequest);
const request = (id: string, overrides: Record<string, unknown> = {}) =>
  decodeRequest({
    id,
    nodeId: "node:question",
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "resolved",
    responseCapability: { type: "message" },
    createdAt: at,
    resolvedAt: at,
    answers: { branch: "dev" },
    respondedBy: { type: "user" },
    ...overrides,
  });
const base = Schema.decodeUnknownSync(ChannelTaskLedgerExportRow)({
  sequence: 20,
  taskId: "task:export",
  ownerId: "owner",
  conversationId: "conversation:export",
  originBindingId: "binding:export",
  originInputId: "input:export",
  title: "Build",
  originAddress: { kind: "goat", environmentId: "env:local", threadId: "thread:bot" },
  requester: {
    ownerId: "owner",
    principalId: "owner",
    displayName: "Owner",
    originKind: "goat",
    runtimeModeCeiling: "full-access",
    grantedScopes: ["orchestration:read"],
  },
  brief: null,
  terminalState: "completed",
  occurredAt: "2026-10-17T02:00:00.000Z",
  resultSummary: "Done",
  evidence: { environmentId: "env:local", threadId: "thread:worker", generation: 1 },
  channelAnswers: 1,
  reruns: 0,
  generation: 1,
});
const encodeSource = Schema.encodeSync(Schema.fromJsonString(ChannelTaskLedgerExportRow));
const decodeRow = Schema.decodeUnknownEffect(Schema.fromJsonString(ChannelTaskExportRow));
const range = {
  ownerId: "owner",
  from: "2026-10-17T00:00:00.000Z",
  to: "2026-10-18T00:00:00.000Z",
};
const answerEventId = ChannelTaskEventId.make("event:channel-answer");
const forwardedRequest = request("request:forwarded");
const forwardedEvent = Schema.decodeUnknownSync(OrchestrationV2StoredEvent)({
  sequence: 1,
  commandId: answerForwardIdsFor(answerEventId).commandId,
  event: {
    id: "event:forwarded",
    threadId: "thread:worker",
    occurredAt: at,
    type: "runtime-request.updated",
    payload: forwardedRequest,
  },
});
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const revision = MemoryRevisionId.make(uuid(1));
const space = MemorySpaceId.make(uuid(2));

const fixture = (
  options: {
    requests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
    row?: ChannelTaskLedgerExportRow;
    state?: "tracked" | "unknown" | "overflow";
    revisions?: ReadonlyArray<MemoryRevisionId>;
    readFailed?: boolean;
    threadReadFailed?: boolean;
    forwarded?: ReadonlyArray<OrchestrationV2StoredEvent>;
    overflow?: boolean;
  } = {},
) => {
  const reads = { threads: 0, memory: 0, forwarding: 0 };
  const dependencies = Layer.mergeAll(
    Layer.mock(ChannelLedger.ChannelLedger)({
      exportTasks: () =>
        Effect.succeed({ jsonl: encodeSource(options.row ?? base) + "\n", nextCursor: "20" }),
      answerEventIdsThrough: () =>
        Effect.succeed({ eventIds: [answerEventId], overflow: options.overflow ?? false }),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.gen(function* () {
          reads.threads += 1;
          if (options.threadReadFailed)
            return yield* new Orchestrator.OrchestratorProjectionError({
              threadId: base.evidence!.threadId,
            });
          return { runtimeRequests: options.requests ?? [] };
        }) as never,
    }),
    Layer.mock(EventSink.EventSinkV2)({
      readByCommandId: ({ commandId }) => {
        reads.forwarding += 1;
        assert.strictEqual(commandId, answerForwardIdsFor(answerEventId).commandId);
        return Stream.fromIterable(options.forwarded ?? []);
      },
    }),
    Layer.mock(MemoryStore.MemoryStore)({
      readThreadLineage: (thread, currentSpace) =>
        Effect.gen(function* () {
          reads.memory += 1;
          assert.strictEqual(thread.threadId, base.evidence?.threadId);
          assert.strictEqual(currentSpace, space);
          if (options.readFailed)
            return yield* new MemoryStore.MemoryStorageError({
              stage: "test-read",
              cause: undefined,
            });
          return {
            kind: "threadLineage" as const,
            sourceThread: thread,
            memorySpaceId: space,
            state: options.state ?? "tracked",
            revisions: options.revisions ?? [revision],
          };
        }),
    }),
    Layer.succeed(Settings.MemoryHubCommittedSettings, {
      read: Effect.succeed({
        settings: { mode: "hub" as const, memorySpaceId: space },
        version: 1,
        provenance: null,
      }),
    }),
  );
  return { reads, layer: ChannelTaskExport.layer.pipe(Layer.provide(dependencies)) };
};

const exportRow = Effect.gen(function* () {
  const service = yield* ChannelTaskExport.ChannelTaskExport;
  const page = yield* service.exportTasks(range);
  assert.strictEqual(page.nextCursor, "20");
  return yield* decodeRow(page.jsonl);
});

describe("channel task export enrichment", () => {
  it.effect(
    "counts direct and relayed human answers, excludes agents, non-answers, late answers and channel forwarding",
    () => {
      const f = fixture({
        requests: [
          request("request:human"),
          request("request:relayed", {
            respondedBy: {
              type: "agent",
              threadId: "thread:parent",
              environmentId: null,
              title: null,
              reason: "User chose dev",
              relayedFromUser: true,
            },
          }),
          request("request:agent", {
            respondedBy: {
              type: "agent",
              threadId: "thread:parent",
              environmentId: null,
              title: null,
              reason: "I chose dev",
            },
          }),
          request("request:client", { respondedBy: { type: "client", reason: "Approved" } }),
          request("request:pending", { status: "pending", resolvedAt: null }),
          request("request:dismissed", { answers: undefined }),
          request("request:late", { resolvedAt: DateTime.makeUnsafe("2026-10-17T03:00:00.000Z") }),
          request("request:approval", { kind: "file-change" }),
          forwardedRequest,
        ],
        forwarded: [forwardedEvent],
      });
      return Effect.gen(function* () {
        const row = yield* exportRow;
        assert.deepStrictEqual(row.humanInterventions, { channelAnswers: 1, threadAnswers: 2 });
        assert.deepStrictEqual(row.memoryDelivered, { state: "tracked", revisions: [revision] });
        assert.strictEqual(f.reads.forwarding, 1);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect.each(["unknown", "overflow"] as const)(
    "preserves %s memory lineage and partial revisions",
    (state) => {
      const revisions = Array.from({ length: state === "overflow" ? 100 : 1 }, (_, index) =>
        MemoryRevisionId.make(uuid(index + 3)),
      );
      const f = fixture({ state, revisions });
      return Effect.gen(function* () {
        assert.deepStrictEqual((yield* exportRow).memoryDelivered, { state, revisions });
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("reports an unavailable local native-question history as unknown", () => {
    const f = fixture({ threadReadFailed: true });
    return Effect.gen(function* () {
      assert.isNull((yield* exportRow).humanInterventions.threadAnswers);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("does not claim empty tracked lineage when the memory read failed", () => {
    const f = fixture({ readFailed: true });
    return Effect.gen(function* () {
      assert.deepStrictEqual((yield* exportRow).memoryDelivered, {
        state: "unknown",
        revisions: [],
      });
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "reports remote thread evidence as unknown without consulting local thread or memory stores",
    () => {
      const f = fixture({ row: { ...base, evidence: { ...base.evidence!, host: "remote-host" } } });
      return Effect.gen(function* () {
        const row = yield* exportRow;
        assert.deepStrictEqual(row.humanInterventions, { channelAnswers: 1, threadAnswers: null });
        assert.deepStrictEqual(row.memoryDelivered, { state: "unknown", revisions: [] });
        assert.deepStrictEqual(f.reads, { threads: 0, memory: 0, forwarding: 0 });
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "does not report a complete count when channel forwarding provenance exceeds the read bound",
    () => {
      const f = fixture({ overflow: true, requests: [request("request:human")] });
      return Effect.gen(function* () {
        assert.isNull((yield* exportRow).humanInterventions.threadAnswers);
      }).pipe(Effect.provide(f.layer));
    },
  );
});

it.effect(
  "the channel graph builds its exporter with the EventSink supplied inside that graph",
  () => {
    const readCommands: Array<CommandId> = [];
    const innerEvents = Layer.effect(
      EventSink.EventSinkV2,
      Effect.gen(function* () {
        const actual = yield* EventSink.EventSinkV2;
        return EventSink.EventSinkV2.of({
          ...actual,
          readByCommandId: (input) => {
            readCommands.push(input.commandId);
            return actual.readByCommandId(input);
          },
        });
      }),
    );
    // Like server.ts: EventSink is provided inside the channel graph and is not re-exported.
    const harness = makeHarness({
      channelsLayer: ChannelLayers.layerServices.pipe(Layer.provide(innerEvents)),
    });
    return Effect.gen(function* () {
      yield* setupBot;
      const exporter = yield* ChannelTaskExport.ChannelTaskExport;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const actualEvents = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const iso = DateTime.formatIso(now);
      const owner = "export-graph-owner";
      yield* ledger.claimOwnership({ token: owner, now: iso, staleBefore: iso });
      const receipt = yield* gateway.ingest(
        goatInput("do: count generation answers", "graph-export"),
        rpcContext,
      );
      yield* reception.receive(receipt.inputId, owner);
      const task = yield* onlyTask;
      const workerId = ThreadId.make("thread:export-graph-worker");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("export-graph-worker"),
        threadId: workerId,
        projectId: scratchProjectId,
        title: "Export graph worker",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
      const move = (spec: Parameters<typeof commitTransition>[2]) =>
        Effect.gen(function* () {
          return yield* commitTransition(ledger, (yield* ledger.getTask(task.taskId))!, spec, {
            owner,
          });
        });
      yield* move({
        type: "task.dispatch.claimed",
        payload: {
          generation: 1,
          leaseExpiresAt: iso,
          target: {
            environmentId,
            projectId: scratchProjectId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
          },
        },
      });
      yield* move({
        type: "task.worker.bound",
        payload: { worker: { environmentId, threadId: workerId, generation: 1 } },
      });
      yield* move({
        type: "task.question.opened",
        payload: {
          question: {
            questionId: "question:export-graph" as never,
            text: "Which branch?",
            askedAt: iso,
          },
        },
      });
      const answered = yield* move({
        type: "task.question.answered",
        payload: { questionId: "question:export-graph" as never, answer: "dev" },
      });
      const native = request("request:graph-native", { createdAt: now, resolvedAt: now });
      yield* actualEvents.write({
        events: [
          {
            id: EventId.make("event:graph-native"),
            threadId: workerId,
            occurredAt: now,
            type: "runtime-request.updated",
            payload: native,
          },
        ],
      });
      yield* move({ type: "task.completed", payload: { generation: 1, summary: "Done" } });
      const page = yield* exporter.exportTasks({
        ownerId: task.requester.ownerId,
        from: iso,
        to: "9999-12-31T23:59:59.999Z",
      });
      const row = yield* decodeRow(page.jsonl);
      assert.deepStrictEqual(row.humanInterventions, { channelAnswers: 1, threadAnswers: 1 });
      assert.deepStrictEqual(readCommands, [
        answerForwardIdsFor(taskEventIdFor(task.taskId, answered!.version)).commandId,
      ]);
    }).pipe(Effect.provide(harness.layer));
  },
);
