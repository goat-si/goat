import { assert } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Hub from "../MemoryHubService.ts";
import * as Service from "../MemoryService.ts";
import * as Store from "../MemoryStore.ts";
import {
  hubEnv,
  otherEnv,
  id,
  principal,
  pullInput,
  pushInput,
  seed,
  space,
} from "../MemoryHubService.testkit.ts";

const features = M.MEMORY_FLOOR_2;
const advertise = { ...pullInput, features };

export const runSummaryPromotionFixture = (
  size: number,
  revokeProject: boolean,
  newMemory: typeof import("../MemoryHubService.testkit.ts").operation,
  forget: (source: ReturnType<typeof newMemory>) => M.MemoryOperation,
) =>
  Effect.gen(function* () {
    yield* seed;
    const hub = yield* Hub.MemoryHubService;
    const service = yield* Service.MemoryService;
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events(application_event_version INTEGER,aggregate_kind TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT)`;
    yield* hub.pull(advertise, principal());
    yield* hub.pull({ ...advertise, environmentId: otherEnv }, principal(otherEnv));
    const toInput = (op: ReturnType<typeof newMemory>): M.MemoryUpsertInput => ({
      memorySpaceId: space,
      memoryId: op.memoryId,
      operationId: op.operationId,
      scope: op.revision.scope,
      assertionKind: op.revision.assertionKind,
      expectedHeads: [],
      payload: op.payload,
      baseBoundary: null,
    });
    const sources = yield* Effect.forEach(
      Array.from({ length: size }, (_, n) => newMemory(38000 + n)),
      (source) => service.upsert(toInput(source), Effect.void),
    );
    const revisionIds = sources.flatMap(({ receipt }) =>
      "revisionId" in receipt && receipt.revisionId ? [receipt.revisionId] : [],
    );
    assert.lengthOf(revisionIds, size);
    const first = newMemory(38000);
    const firstOp = yield* store.readWorkOperation(`sync:${space}:${first.operationId}`);
    if (!firstOp || firstOp.kind !== "upsert") throw new Error("Expected a source operation");
    yield* sql`UPDATE memory_outbox SET status='completed' WHERE space=${space} AND kind='sync'`;
    const thread = {
      environmentId: hubEnv,
      threadId: M.ThreadId.make("synthetic-promoted-thread"),
    };
    yield* store.appendThreadLineage(thread, space, revisionIds);
    const project = {
      environmentId: hubEnv,
      projectId: M.ProjectId.make("synthetic-promotion-project"),
    };
    const projectKey = { kind: "explicit" as const, sharedProjectId: "synthetic-old-project" };
    const binding = { memorySpaceId: space, project, projectKey, repositoryKey: null, version: 1 };
    if (revokeProject) yield* store.putProjectBinding(binding, null, 0);
    const summary = newMemory(902);
    const eventId = M.EventId.make(id(22000));
    const sourceWatermark = { fromEventId: eventId, toEventId: eventId, throughSequence: 1 };
    const selection = { instanceId: M.ProviderInstanceId.make("fixture"), model: "fixture" };
    const messageId = M.MessageId.make("synthetic-evidence");
    const input: M.GenerateMemorySummaryInput = {
      cwd: "/synthetic",
      sourceThread: thread,
      sourceWatermark,
      modelSelection: selection,
      messages: [{ messageId, text: "Synthetic source words.", completed: true }],
    };
    const execution = {
      requestedModelSelection: selection,
      providerInstanceId: selection.instanceId,
      environmentId: hubEnv,
      effectiveProvider: M.ProviderDriverKind.make("codex"),
      effectiveModel: selection.model,
    };
    const result = {
      text: "A synthetic summary",
      assertionKind: "fact" as const,
      evidence: [
        {
          origin: "thread" as const,
          sourceThread: thread,
          watermark: sourceWatermark,
          messageIds: [messageId],
        },
      ],
    };
    const work: Store.MemoryWork = {
      id: "synthetic-summary-promotion",
      space,
      memoryId: summary.memoryId,
      kind: "consolidate",
      status: "pending",
      claimedBy: null,
      claimedUntil: null,
      attempt: 0,
      nextAttemptAt: 0,
      payloadRef: null,
      metadata: {
        kind: "summary",
        sourceThread: thread,
        sourceWatermark,
        memoryId: summary.memoryId,
        operationId: summary.operationId,
        revisionId: summary.revision.revisionId,
        modelSelection: selection,
      },
    };
    yield* service.queueSummary(work);
    assert.isTrue(yield* store.claimWork(work.id, "synthetic-worker", 0, 10000));
    const claimed = yield* store.readWork(work.id);
    if (!claimed) throw new Error("Expected a claimed summary");
    yield* service.commitSummary({
      work: claimed,
      input,
      expectedHeads: [],
      recheckSource: Effect.void,
      generated: { execution, result },
      promotions: {
        input,
        execution,
        replace: true,
        project: revokeProject ? { project, projectKey } : null,
        candidates: {
          user: { ...result, text: "Synthetic promotion" },
          project: revokeProject ? { ...result, text: "Synthetic project promotion" } : null,
        },
      },
    });
    const promotionId = M.MemoryId.make(
      Service.memoryStableUuid(`${thread.environmentId}:${thread.threadId}:promotion:user`),
    );
    const key = `project:${JSON.stringify(projectKey)}`;
    const projectPromotion = M.MemoryId.make(
      Service.memoryStableUuid(`${thread.environmentId}:${thread.threadId}:promotion:${key}`),
    );
    if (revokeProject) {
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND memory_id=${projectPromotion}`,
        1,
      );
      yield* store.putProjectBinding({ ...binding, version: 2, projectKey: null }, 1, 1);
    }
    const eligible = store.readEligibleOutbox(space, 0, 100);
    assert.isUndefined((yield* store.loadAggregate(space, summary.memoryId)).item);
    assert.isUndefined((yield* store.loadAggregate(space, promotionId)).item);
    assert.isFalse((yield* eligible).some((row) => row.work.memoryId === promotionId));
    const summaryOp = yield* store.readWorkOperation(`sync:${space}:${summary.operationId}`);
    if (!summaryOp) throw new Error("Expected a staged summary");
    assert.propertyVal(
      (yield* hub.push({ ...pushInput(summaryOp), features }, principal())).receipts[0],
      "outcome",
      "accepted",
    );
    assert.propertyVal(
      (yield* store.loadAggregate(space, summary.memoryId)).item,
      "status",
      "active",
    );
    assert.isUndefined((yield* store.loadAggregate(space, promotionId)).item);
    const eligibleAfterSummary = yield* eligible;
    for (const row of eligibleAfterSummary) {
      if (row.work.memoryId !== projectPromotion) continue;
      const op = yield* store.readWorkOperation(row.work.id);
      if (op) yield* hub.push({ ...pushInput(op), features }, principal());
    }
    if (revokeProject) {
      assert.isEmpty(
        yield* sql`SELECT 1 FROM memory_hub_operations WHERE space=${space} AND memory_id=${projectPromotion}`,
      );
      assert.isEmpty(
        yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND memory_id=${projectPromotion}`,
      );
    }
    const candidate = eligibleAfterSummary.find((row) => row.work.memoryId === promotionId);
    if (size === 1000) {
      assert.isUndefined(candidate);
      return;
    }
    assert.isDefined(candidate);
    const promotion = candidate ? yield* store.readWorkOperation(candidate.work.id) : undefined;
    if (!promotion || promotion.kind !== "upsert") throw new Error("Expected a staged promotion");
    assert.lengthOf(promotion.payload.derivedFromMemoryRevisions, 102);
    assert.propertyVal(
      (yield* hub.push({ ...pushInput(promotion), features }, principal())).receipts[0],
      "outcome",
      "accepted",
    );
    assert.propertyVal((yield* store.loadAggregate(space, promotionId)).item, "status", "active");
    assert.propertyVal(
      (yield* hub.push(
        { ...pushInput(forget(firstOp)), features, environmentId: otherEnv },
        principal(otherEnv),
      )).receipts[0],
      "outcome",
      "deleted",
    );
    for (const memoryId of [summary.memoryId, promotionId])
      assert.propertyVal((yield* store.loadAggregate(space, memoryId)).item, "status", "blocked");
  });
