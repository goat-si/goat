import { expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Snapshot from "../../../memory/MemorySnapshot.ts";
import * as Sync from "../../../memory/MemorySyncService.ts";
import * as Projection from "../../../orchestration-v2/ProjectionStore.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Service from "../../../memory/MemoryService.ts";
import * as Store from "../../../memory/MemoryStore.ts";
import * as Fixture from "./handlers.testkit.ts";
import { threadProvenanceCases } from "../../../memory/threadProvenance.testkit.ts";

const caller = (name = "r5-caller") => ({
  ...Fixture.scope(),
  thread: {
    threadId: M.ThreadId.make(name),
    providerSessionId: "synthetic",
    providerInstanceId: M.ProviderInstanceId.make("codex"),
  },
  client: undefined,
});
const ref = (name = "r5-caller") => ({
  environmentId: Fixture.scope().environmentId,
  threadId: M.ThreadId.make(name),
});
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_events(application_event_version INTEGER,aggregate_kind TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT)`;
});
const admitSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* Service.MemoryService;
  const store = yield* Store.MemoryStore;
  yield* sql`CREATE TABLE IF NOT EXISTS projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT)`;
  yield* sql`INSERT INTO projection_projects SELECT 'project:mcp-test','/synthetic',NULL WHERE NOT EXISTS(SELECT 1 FROM projection_projects)`;
  return yield* Effect.gen(function* () {
    const policy = { grant: "read" as const, policyEpoch: 1 };
    return yield* (yield* Snapshot.MemorySnapshot).forThread(
      ref().threadId,
      policy,
      Effect.succeed(policy),
    );
  }).pipe(
    Effect.provide(
      Snapshot.layer.pipe(
        Layer.provide(Layer.succeed(Service.MemoryService, service)),
        Layer.provide(Layer.succeed(Store.MemoryStore, store)),
        Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
        Layer.provide(
          Layer.succeed(Environment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(ref().environmentId),
          }),
        ),
        Layer.provide(
          Layer.mock(Sync.MemorySyncService)({
            readLocalReadiness: () =>
              Effect.succeed({ memorySpaceId: Fixture.space, bootstrap: "ready" as const }),
          }),
        ),
        Layer.provide(
          Layer.mock(Projection.ProjectionStoreV2)({
            getThreadShell: (threadId) =>
              Effect.succeed({
                ...liveThreadShell(threadId),
                activityRunStatus: "running" as const,
              }),
          }),
        ),
      ),
    ),
  );
});
const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT (SELECT count(*) FROM memory_events) AS events,(SELECT count(*) FROM memory_payloads) AS payloads,(SELECT count(*) FROM memory_outbox WHERE space!='_worker') AS outbox`;
});
const seed = (n: number, deps: ReadonlyArray<M.MemoryRevisionId> = []) =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const store = yield* Store.MemoryStore;
    const input = {
      ...Fixture.upsert(n),
      memoryId: M.MemoryId.make(Fixture.id(n + 1000)),
      payload: { text: `synthetic ${n}`, evidence: [], derivedFromMemoryRevisions: deps },
    };
    yield* service.upsert(input, Effect.void);
    return {
      input,
      revision: (yield* store.loadAggregate(Fixture.space, input.memoryId)).heads[0]!,
    };
  });
it.effect(
  "M-R4-1 toolkit replays first receipt after context growth, fence and forget without writes",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const service = yield* Service.MemoryService;
      const a = yield* seed(16000);
      expect(yield* admitSnapshot).toBeDefined();
      const input = Fixture.upsert(16001);
      const first = yield* Fixture.call("memory_upsert", input, caller());
      expect(first.result.isError).not.toBe(true);
      const b = yield* seed(16002);
      expect((yield* admitSnapshot)?.items.map((item) => item.revisionId)).toContain(b.revision);
      const before = yield* counts;
      expect((yield* Fixture.call("memory_upsert", input, caller())).body).toEqual(first.body);
      const variants = [
        { ...input, payload: { ...input.payload, text: "changed" } },
        {
          ...input,
          payload: {
            ...input.payload,
            evidence: [
              {
                origin: "thread" as const,
                sourceThread: ref(),
                watermark: {
                  fromEventId: M.EventId.make(Fixture.id(16010)),
                  toEventId: M.EventId.make(Fixture.id(16011)),
                  throughSequence: 1,
                },
                messageIds: [M.MessageId.make("changed")],
              },
            ],
          },
        },
        { ...input, payload: { ...input.payload, derivedFromMemoryRevisions: [a.revision] } },
        { ...input, expectedHeads: [a.revision] },
        { ...input, scope: { kind: "thread" as const, thread: ref() } },
      ];
      for (const variant of variants)
        expect((yield* Fixture.call("memory_upsert", variant, caller())).body).toMatchObject({
          code: "operation_id_reused",
        });
      expect(yield* counts).toEqual(before);
      yield* service.forget(
        {
          memorySpaceId: Fixture.space,
          memoryId: a.input.memoryId,
          operationId: M.MemoryOperationId.make(Fixture.id(16003)),
          expectedHeads: [a.revision],
        },
        Effect.void,
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_events VALUES(2,'thread',${ref().threadId},'context-transfer.created',${'{"targetThreadId":"r5-caller","sourceThreadId":"other"}'})`;
      const afterForget = yield* counts;
      expect((yield* Fixture.call("memory_upsert", input, caller())).body).toEqual(first.body);
      expect(yield* counts).toEqual(afterForget);
      expect(
        yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${input.memoryId}`,
      ).toHaveLength(0);
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect.each(["fork", "import", "transfer", "overflow"] as const)(
  "r5 incomplete %s rejects caller user/project writes and exposes guidance",
  (kind) =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      if (kind === "overflow")
        yield* store.appendThreadLineage(
          ref(),
          Fixture.space,
          Array.from({ length: 101 }, (_, n) => M.MemoryRevisionId.make(Fixture.id(17000 + n))),
        );
      else {
        const payload =
          kind === "fork"
            ? '{"forkedFrom":{"type":"run","threadId":"other","runId":"source-run"}}'
            : kind === "import"
              ? '{"historyOrigin":"v1_import"}'
              : '{"targetThreadId":"r5-caller","sourceThreadId":"other"}';
        yield* sql`INSERT INTO orchestration_events VALUES(2,'thread',${ref().threadId},${kind === "transfer" ? "context-transfer.created" : "thread.created"},${payload})`;
      }
      const before = yield* counts;
      for (const scope of [
        { kind: "user" as const },
        {
          kind: "project" as const,
          projectKey: { kind: "explicit" as const, sharedProjectId: "synthetic-project" },
        },
      ]) {
        const result = yield* Fixture.call(
          "memory_upsert",
          { ...Fixture.upsert(), scope },
          caller(),
        );
        expect(result.result.isError).toBe(true);
        expect(result.body).toMatchObject({
          code: "thread_lineage_incomplete",
          guidance:
            "This conversation has incomplete memory provenance and cannot save new memories. Start a new conversation to save this memory.",
        });
      }
      expect(yield* counts).toEqual(before);
      expect((yield* Fixture.call("memory_upsert", Fixture.upsert())).result.isError).not.toBe(
        true,
      );
      yield* (yield* Service.MemoryService).upsert(
        { ...Fixture.upsert(17002), memoryId: M.MemoryId.make(Fixture.id(17003)) },
        Effect.void,
      );
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("r5 writer transaction observes lineage changed while upsert waits", () =>
  Effect.gen(function* () {
    yield* setup;
    const store = yield* Store.MemoryStore;
    const entered = yield* Deferred.make<void>();
    const locked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* store
      .transact(
        Effect.gen(function* () {
          yield* Deferred.succeed(locked, undefined);
          yield* Deferred.await(release);
          yield* store.appendThreadLineage(
            ref(),
            Fixture.space,
            Array.from({ length: 101 }, (_, n) => M.MemoryRevisionId.make(Fixture.id(18000 + n))),
          );
        }),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(locked);
    const request = yield* Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Fixture.call("memory_upsert", Fixture.upsert(), caller())),
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    expect((yield* Fiber.join(request)).body).toMatchObject({ code: "thread_lineage_incomplete" });
    expect(yield* counts).toEqual([{ events: 0, payloads: 0, outbox: 0 }]);
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect.each(["memory_read", "memory_list", "memory_search", "memory_history"] as const)(
  "r5 %s records only returned bodies and closed dependencies",
  (name) =>
    Effect.gen(function* () {
      yield* setup;
      const store = yield* Store.MemoryStore;
      const a = yield* seed(19000);
      const b = yield* seed(19001, [a.revision]);
      yield* seed(19002);
      const input =
        name === "memory_list"
          ? {
              memorySpaceId: Fixture.space,
              includeQuarantined: false,
              limit: 1,
              cursor: a.input.memoryId,
            }
          : name === "memory_search"
            ? { memorySpaceId: Fixture.space, query: "19001", mode: "substring", limit: 1 }
            : name === "memory_history"
              ? { memorySpaceId: Fixture.space, memoryId: b.input.memoryId, limit: 1 }
              : { memorySpaceId: Fixture.space, memoryId: b.input.memoryId };
      expect((yield* Fixture.call(name, input, caller())).result.isError).not.toBe(true);
      expect(new Set((yield* store.readThreadLineage(ref(), Fixture.space)).revisions)).toEqual(
        new Set([a.revision, b.revision]),
      );
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT 1 FROM memory_outbox WHERE space='_worker'`).toHaveLength(1);
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("r5 read recording fails closed and metadata-only reads leave no lineage", () =>
  Effect.gen(function* () {
    yield* setup;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* Store.MemoryStore;
    const service = yield* Service.MemoryService;
    const a = yield* seed(20000);
    yield* sql`CREATE TRIGGER fail_lineage BEFORE INSERT ON memory_outbox WHEN NEW.space='_worker' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`;
    const failed = yield* Fixture.call(
      "memory_read",
      { memorySpaceId: Fixture.space, memoryId: a.input.memoryId },
      caller(),
    );
    expect(failed.result.isError).toBe(true);
    expect(JSON.stringify(failed.body)).not.toContain("synthetic 20000");
    yield* sql`DROP TRIGGER fail_lineage`;
    yield* service.forget(
      {
        memorySpaceId: Fixture.space,
        memoryId: a.input.memoryId,
        operationId: M.MemoryOperationId.make(Fixture.id(20001)),
        expectedHeads: [a.revision],
      },
      Effect.void,
    );
    expect(
      (yield* Fixture.call(
        "memory_read",
        { memorySpaceId: Fixture.space, memoryId: a.input.memoryId },
        caller(),
      )).result.isError,
    ).not.toBe(true);
    expect(yield* sql`SELECT 1 FROM memory_outbox WHERE space='_worker'`).toHaveLength(0);
    expect((yield* store.readThreadLineage(ref(), Fixture.space)).revisions).toEqual([]);
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect(
  "r5 101st read persists sticky overflow but returns body; unknown read preserves fence",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const store = yield* Store.MemoryStore;
      const a = yield* seed(21000);
      yield* store.appendThreadLineage(
        ref(),
        Fixture.space,
        Array.from({ length: 100 }, (_, n) => M.MemoryRevisionId.make(Fixture.id(22000 + n))),
      );
      const input = { memorySpaceId: Fixture.space, memoryId: a.input.memoryId };
      expect((yield* Fixture.call("memory_read", input, caller())).result.isError).not.toBe(true);
      expect((yield* store.readThreadLineage(ref(), Fixture.space)).state).toBe("overflow");
      expect((yield* store.readThreadLineage(ref(), Fixture.space)).revisions).toHaveLength(100);
      expect((yield* Fixture.call("memory_upsert", Fixture.upsert(), caller())).body).toMatchObject(
        { code: "thread_lineage_incomplete" },
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_events VALUES(2,'thread','unknown','thread.created','{"historyOrigin":"v1_import"}')`;
      expect(
        (yield* Fixture.call("memory_read", input, caller("unknown"))).result.isError,
      ).not.toBe(true);
      expect(yield* store.readThreadLineage(ref("unknown"), Fixture.space)).toMatchObject({
        state: "unknown",
        revisions: [a.revision],
      });
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect.each(threadProvenanceCases(ref().threadId))(
  "production origin $name: $state permits only tracked MCP writes",
  (origin) =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      yield* sql`INSERT INTO orchestration_events VALUES(2,'thread',${ref().threadId},'thread.created',${origin.createdJson})`;
      for (const event of origin.events)
        yield* sql`INSERT INTO orchestration_events VALUES(2,'thread',${event.streamId},${event.type},${event.payloadJson})`;
      if (origin.events.some((event) => event.type === "subagent.updated")) {
        const history = yield* sql<{
          role: string;
          text: string;
        }>`SELECT json_extract(payload_json,'$.role') AS role,json_extract(payload_json,'$.text') AS text FROM orchestration_events WHERE stream_id=${ref().threadId} AND event_type='message.updated'`;
        expect(history).toEqual([
          { role: "user", text: "Initial delegated task" },
          { role: "assistant", text: "Child previous answer" },
          { role: "user", text: "Continue your previous answer" },
        ]);
        const spawn = yield* sql<{
          event_type: string;
        }>`SELECT event_type FROM orchestration_events WHERE stream_id=${ref().threadId} AND event_type IN ('context-transfer.created','context-transfer.updated')`;
        expect(spawn).toEqual([{ event_type: "context-transfer.created" }]);
        const tasks = yield* sql<{
          prompt: string;
          child: string;
        }>`SELECT json_extract(payload_json,'$.prompt') AS prompt,json_extract(payload_json,'$.childThreadId') AS child FROM orchestration_events WHERE stream_id='parent' AND event_type='subagent.updated'`;
        expect(tasks).toEqual([{ prompt: "Continue your previous answer", child: ref().threadId }]);
        // Own previous answer is retained above; the parent's sentinel is absent.
      }
      expect((yield* store.readThreadLineage(ref(), Fixture.space)).state).toBe(origin.state);
      const before = yield* counts;
      const saved = yield* Fixture.call("memory_upsert", Fixture.upsert(), caller());
      if (origin.state === "tracked") {
        expect(saved.result.isError, JSON.stringify(saved.body)).not.toBe(true);
        expect((yield* store.loadAggregate(Fixture.space, Fixture.memoryId)).heads).toHaveLength(1);
      } else {
        expect(saved.result.isError).toBe(true);
        expect(saved.body).toMatchObject({ code: "thread_lineage_incomplete" });
        expect(yield* counts).toEqual(before);
      }
    }).pipe(Effect.provide(Fixture.layer)),
);
