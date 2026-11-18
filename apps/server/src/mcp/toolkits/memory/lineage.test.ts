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
import * as Settings from "../../../serverSettings.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Service from "../../../memory/MemoryService.ts";
import * as Store from "../../../memory/MemoryStore.ts";
import { MemoryRefusedSaveHook } from "../../../memory/MemoryRemember.ts";
import * as Fixture from "./handlers.testkit.ts";
import {
  appOwnedTaskResultEvents,
  threadProvenanceCases,
} from "../../../memory/threadProvenance.testkit.ts";

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
  yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT,deleted_at TEXT,archived_at TEXT,updated_at TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,ordinal INTEGER,status TEXT,payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,role TEXT,payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,run_id TEXT,type TEXT,status TEXT)`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('r5-caller','project:mcp-test',NULL,NULL,'2026-01-01')`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('run:mcp-test','r5-caller',1,'running','{}')`;
});
const admitSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* Service.MemoryService;
  const store = yield* Store.MemoryStore;
  yield* sql`CREATE TABLE IF NOT EXISTS projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT)`;
  yield* sql`INSERT INTO projection_projects SELECT 'project:mcp-test','/synthetic',NULL WHERE NOT EXISTS(SELECT 1 FROM projection_projects)`;
  return yield* Effect.gen(function* () {
    const policy = { grant: "read" as const, policyEpoch: 1, finalAuthority: Effect.succeed(true) };
    return yield* (yield* Snapshot.MemorySnapshot).forThread(
      ref().threadId,
      policy,
      Effect.succeed(policy),
    );
  }).pipe(
    Effect.provide(
      Snapshot.layer.pipe(
        Layer.provide(
          Layer.succeed(Settings.MemoryHubCommittedSettings, {
            read: Effect.succeed({
              provenance: null,
              settings: { mode: "hub" as const, memorySpaceId: Fixture.space },
              version: 1,
            }),
          }),
        ),
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
            getRunMessage: () => Effect.sync(() => undefined),
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
          Array.from({ length: 1001 }, (_, n) => M.MemoryRevisionId.make(Fixture.id(17000 + n))),
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
          guidance: M.MEMORY_LINEAGE_GUIDANCE,
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
            Array.from({ length: 1001 }, (_, n) => M.MemoryRevisionId.make(Fixture.id(18000 + n))),
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
      expect(yield* sql`SELECT 1 FROM memory_thread_lineages`).toHaveLength(1);
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("r5 read recording fails closed and metadata-only reads leave no lineage", () =>
  Effect.gen(function* () {
    yield* setup;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* Store.MemoryStore;
    const service = yield* Service.MemoryService;
    const a = yield* seed(20000);
    yield* sql`CREATE TRIGGER fail_lineage BEFORE INSERT ON memory_thread_lineage_revisions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`;
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
    expect(yield* sql`SELECT 1 FROM memory_thread_lineages`).toHaveLength(0);
    expect((yield* store.readThreadLineage(ref(), Fixture.space)).revisions).toEqual([]);
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect(
  "r5 1001st read persists sticky overflow but returns body; unknown read preserves fence",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const store = yield* Store.MemoryStore;
      const a = yield* seed(21000);
      yield* store.appendThreadLineage(
        ref(),
        Fixture.space,
        Array.from({ length: 1000 }, (_, n) => M.MemoryRevisionId.make(Fixture.id(22000 + n))),
      );
      const input = { memorySpaceId: Fixture.space, memoryId: a.input.memoryId };
      expect((yield* Fixture.call("memory_read", input, caller())).result.isError).not.toBe(true);
      expect((yield* store.readThreadLineage(ref(), Fixture.space)).state).toBe("overflow");
      expect((yield* store.readThreadLineage(ref(), Fixture.space)).revisions).toHaveLength(1000);
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
      if (origin.events.some((event) => event.type === "message.updated")) {
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

const linkTask = (parent: M.ThreadId, child: M.ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const event of appOwnedTaskResultEvents(parent, child))
      yield* sql`INSERT INTO orchestration_events VALUES(2,'thread',${event.streamId},${event.type},${event.payloadJson})`;
  });
const revisions = (from: number, length: number) =>
  Array.from({ length }, (_, n) => M.MemoryRevisionId.make(Fixture.id(from + n)));

it.effect("app-owned task results carry child lineage into parent saves and retries replay", () =>
  Effect.gen(function* () {
    yield* setup;
    const store = yield* Store.MemoryStore;
    const child = ref("r5-task-child");
    const grandchild = ref("r5-task-grandchild");
    const a = yield* seed(25000);
    const b = yield* seed(25100);
    yield* store.appendThreadLineage(child, Fixture.space, [a.revision]);
    yield* store.appendThreadLineage(grandchild, Fixture.space, [b.revision]);
    yield* linkTask(ref().threadId, child.threadId);
    yield* linkTask(child.threadId, grandchild.threadId);
    const saved = yield* Fixture.call("memory_upsert", Fixture.upsert(), caller());
    expect(saved.result.isError, JSON.stringify(saved.body)).not.toBe(true);
    const aggregate = yield* store.loadAggregate(Fixture.space, Fixture.memoryId);
    const head = aggregate.revisions.find(
      (pair) => pair.revision.revisionId === aggregate.heads[0],
    );
    expect(head?.payload?.derivedFromMemoryRevisions).toEqual(
      expect.arrayContaining([a.revision, b.revision]),
    );
    const before = yield* counts;
    expect((yield* Fixture.call("memory_upsert", Fixture.upsert(), caller())).body).toEqual(
      saved.body,
    );
    expect(yield* counts).toEqual(before);
  }).pipe(Effect.provide(Fixture.layer)),
);

const taskChild = ref("r5-task-child");
const appendLineage = (
  thread: M.ScopedThreadRef,
  space: M.MemorySpaceId,
  ids: ReadonlyArray<M.MemoryRevisionId>,
) =>
  Effect.gen(function* () {
    yield* (yield* Store.MemoryStore).appendThreadLineage(thread, space, ids);
  });
it.effect.each([
  {
    name: "own and child lineage past 1000 revisions",
    state: "overflow",
    arrange: Effect.all([
      appendLineage(ref(), Fixture.space, revisions(26000, 600)),
      appendLineage(taskChild, Fixture.space, revisions(27000, 500)),
      linkTask(ref().threadId, taskChild.threadId),
    ]),
  },
  {
    name: "an overflowed child",
    state: "overflow",
    arrange: Effect.all([
      appendLineage(taskChild, Fixture.space, revisions(26200, 1001)),
      linkTask(ref().threadId, taskChild.threadId),
    ]),
  },
  {
    name: "a child lineage recorded in another memory space",
    state: "unknown",
    arrange: Effect.all([
      appendLineage(taskChild, M.MemorySpaceId.make(Fixture.id(26999)), revisions(26300, 1)),
      linkTask(ref().threadId, taskChild.threadId),
    ]),
  },
  {
    name: "more than 100 task children",
    state: "overflow",
    arrange: Effect.forEach(
      Array.from({ length: 101 }, (_, n) => M.ThreadId.make(`r5-task-child-${n}`)),
      (child) => linkTask(ref().threadId, child),
    ),
  },
] as const)("app-owned task results from $name fail closed as $state", ({ arrange, state }) =>
  Effect.gen(function* () {
    yield* setup;
    yield* arrange;
    const store = yield* Store.MemoryStore;
    expect((yield* store.readThreadLineage(ref(), Fixture.space)).state).toBe(state);
    const before = yield* counts;
    const saved = yield* Fixture.call("memory_upsert", Fixture.upsert(), caller());
    expect(saved.result.isError).toBe(true);
    expect(saved.body).toMatchObject({ code: "thread_lineage_incomplete" });
    expect(yield* counts).toEqual(before);
  }).pipe(Effect.provide(Fixture.layer)),
);

const rememberSetup = Effect.gen(function* () {
  yield* setup;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_events ADD COLUMN event_id TEXT`;
  yield* sql`ALTER TABLE orchestration_events ADD COLUMN sequence INTEGER`;
  yield* sql`ALTER TABLE orchestration_v2_projection_messages ADD COLUMN thread_id TEXT`;
});
const remember = (text: string) =>
  Fixture.call("goat_memory_remember", { scope: "user", text }, caller());

it.effect("remember offers a refused wide save to the suggestion hook", () => {
  const offered: Parameters<MemoryRefusedSaveHook["Service"]["onRefusedSave"]>[0][] = [];
  const hook = Layer.succeed(MemoryRefusedSaveHook, {
    onRefusedSave: (candidate) =>
      Effect.sync(() => {
        offered.push(candidate);
      }),
  });
  return Effect.gen(function* () {
    yield* rememberSetup;
    yield* appendLineage(ref(), Fixture.space, revisions(31000, 101));
    expect((yield* remember("offer these words")).body).toMatchObject({
      code: "hub_upgrade_required",
    });
    expect(offered).toMatchObject([
      {
        thread: ref(),
        reason: "hub_upgrade_required",
        input: { payload: { text: "offer these words" } },
      },
    ]);
  }).pipe(Effect.provide(Fixture.layer.pipe(Layer.provide(hook))));
});

it.effect("remember with 101 sources on the old floor asks for a hub upgrade", () =>
  Effect.gen(function* () {
    yield* rememberSetup;
    yield* appendLineage(ref(), Fixture.space, revisions(31000, 101));
    const before = yield* counts;
    const result = yield* remember("synthetic candidate");
    expect(result.result.isError).toBe(true);
    expect(result.body).toMatchObject({ code: "hub_upgrade_required" });
    expect(yield* counts).toEqual(before);
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect.each([101, 1000])(
  "remember on the new floor preserves %s sources through edits and forget",
  (size) =>
    Effect.gen(function* () {
      yield* rememberSetup;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      yield* sql`INSERT INTO memory_space_features VALUES (${Fixture.space},1000,0)`;
      const sources = yield* Effect.forEach(
        Array.from({ length: size }, (_, n) => 32000 + n),
        (n) => seed(n),
      );
      yield* appendLineage(
        ref(),
        Fixture.space,
        sources.map((source) => source.revision),
      );
      if (size === 1000) {
        yield* rememberFromActiveRun("Write a wide synthetic memory down.", person);
        yield* appendLineage(ref(), Fixture.space, revisions(35600, 1));
        expect((yield* store.readThreadLineage(ref(), Fixture.space)).state).toBe("overflow");
      }
      const saved = yield* remember("a wide synthetic memory");
      expect(saved.result.isError).not.toBe(true);
      const row = (yield* sql<{ memory_id: string }>`
      SELECT p.memory_id FROM memory_payloads p WHERE json_extract(p.body_json,'$.text')='a wide synthetic memory'`)[0]!;
      const memoryId = M.MemoryId.make(row.memory_id);
      const before = yield* store.loadAggregate(Fixture.space, memoryId);
      expect(before.revisions[0]?.payload?.derivedFromMemoryRevisions).toEqual(
        sources.map((source) => source.revision),
      );
      const projected = yield* service.read(
        { memorySpaceId: Fixture.space, memoryId, includeMarks: true },
        Effect.void,
      );
      expect(projected.marks).toEqual(
        size === 1000
          ? { originThreadId: ref().threadId, provenance: "unverified" }
          : { originThreadId: ref().threadId },
      );
      const list = yield* service.list(
        {
          memorySpaceId: Fixture.space,
          limit: 5,
          includeQuarantined: false,
          includeMarks: true,
          cursor: sources.at(-1)!.input.memoryId,
        },
        Effect.void,
      );
      expect(list.items).toEqual([projected]);
      const history = yield* service.history(
        {
          memorySpaceId: Fixture.space,
          memoryId,
          includeMarks: true,
          limit: 5,
        },
        Effect.void,
      );
      expect(history.revisions[0]?.payload?.derivedFromMemoryRevisions).toHaveLength(size);
      const legacy = yield* service.read({ memorySpaceId: Fixture.space, memoryId }, Effect.void);
      expect(legacy.status).toBe("active");
      if (legacy.status !== "active") throw new Error("expected wide active memory");
      expect(legacy.payload.derivedFromMemoryRevisions).toEqual([]);
      yield* service.upsert(
        {
          ...Fixture.upsert(36098),
          memoryId,
          expectedHeads: [legacy.revision.revisionId],
          payload: { ...legacy.payload, text: "a legacy Settings edit" },
        },
        Effect.void,
      );
      const edited = yield* store.loadAggregate(Fixture.space, memoryId);
      expect(
        edited.revisions.find((r) => r.revision.revisionId === edited.heads[0])?.payload
          ?.derivedFromMemoryRevisions,
      ).toEqual(sources.map((source) => source.revision));
      const last = sources.at(-1)!;
      yield* service.forget(
        {
          memorySpaceId: Fixture.space,
          memoryId: last.input.memoryId,
          operationId: M.MemoryOperationId.make(Fixture.id(36099)),
          expectedHeads: [last.revision],
        },
        Effect.void,
      );
      const after = yield* store.loadAggregate(Fixture.space, memoryId);
      expect(after.item?.status).toBe("blocked");
      expect(after.item).toMatchObject({ failureCode: "source_invalidated" });
      expect(after.revisions.every((entry) => entry.payload === null)).toBe(true);
    }).pipe(Effect.provide(Fixture.layer)),
);

const rememberFromActiveRun = Effect.fn("test.rememberFromActiveRun")(function* (
  text: string,
  origin: {
    createdBy: string;
    creationSource: string;
    ingress?: string;
    scheduledTaskId?: string;
    senderThreadId?: string;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const messageId = "synthetic-root";
  const threadId = ref().threadId;
  const timestamp = "2026-01-01T00:00:00.000Z";
  yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.userMessageId',${messageId})`;
  yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id,role,thread_id,payload_json)
    VALUES (${messageId},'user',${threadId},${JSON.stringify({
      ...origin,
      id: messageId,
      threadId,
      runId: "run:mcp-test",
      nodeId: null,
      role: "user",
      text,
      attachments: [],
      streaming: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    })})`;
});
const person = { createdBy: "user", creationSource: "web", ingress: "person" } as const;
const prepareRefusedLineage = Effect.gen(function* () {
  yield* rememberSetup;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_space_features VALUES (${Fixture.space},1000,0)`;
  yield* sql`INSERT INTO memory_thread_lineages VALUES (${ref().environmentId},${ref().threadId},${Fixture.space},'overflow',0)`;
});

it.effect("an overflowed thread can save only the person's own words as unverified", () =>
  Effect.gen(function* () {
    yield* prepareRefusedLineage;
    yield* rememberFromActiveRun("Don't remember cafe\u0301   on Saturday.", person);
    const refused = yield* remember("coffee on Saturday");
    expect(refused.body).toMatchObject({ code: "thread_lineage_incomplete" });
    const saved = yield* remember("café on Saturday");
    expect(saved.result.isError).not.toBe(true);
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT provenance FROM memory_revision_marks`).toEqual([
      { provenance: "unverified" },
    ]);
    expect(yield* sql`SELECT environment_id,thread_id FROM memory_origins`).toEqual([
      { environment_id: ref().environmentId, thread_id: ref().threadId },
    ]);
    expect((yield* remember("café on Saturday")).body).toMatchObject({
      code: "thread_lineage_incomplete",
    });
    yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed'`;
    expect((yield* remember("on Saturday")).body).toMatchObject({
      code: "thread_lineage_incomplete",
    });
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect.each([
  { ...person, ingress: undefined },
  { ...person, createdBy: "agent" },
  { ...person, creationSource: "server" },
  { ...person, creationSource: "slack" },
  { ...person, scheduledTaskId: "schedule" },
  { ...person, senderThreadId: "thread:sender" },
] as const)("refuses same-text recall from an untrusted root (%j)", (origin) =>
  Effect.gen(function* () {
    yield* prepareRefusedLineage;
    yield* rememberFromActiveRun("coffee on Saturday", origin);
    expect((yield* remember("on Saturday")).body).toMatchObject({
      code: "thread_lineage_incomplete",
    });
    expect(yield* counts).toEqual([{ events: 0, payloads: 0, outbox: 0 }]);
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("explicitly reading an unverified body makes the reader lineage unknown", () =>
  Effect.gen(function* () {
    yield* setup;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* Store.MemoryStore;
    const source = yield* seed(34000);
    yield* sql`INSERT INTO memory_revision_marks VALUES (${Fixture.space},${source.revision},'unverified')`;
    const read = yield* Fixture.call(
      "memory_read",
      { memorySpaceId: Fixture.space, memoryId: source.input.memoryId },
      caller(),
    );
    expect(read.result.isError).not.toBe(true);
    expect(yield* store.readThreadLineage(ref(), Fixture.space)).toEqual({
      state: "unknown",
      revisions: [source.revision],
    });
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("memory projections expose marks only when requested", () =>
  Effect.gen(function* () {
    yield* setup;
    const sql = yield* SqlClient.SqlClient;
    const service = yield* Service.MemoryService;
    const source = yield* seed(35000);
    yield* sql`INSERT INTO memory_revision_marks VALUES (${Fixture.space},${source.revision},'unverified')`;
    yield* sql`INSERT INTO memory_origins VALUES (${Fixture.space},${source.input.memoryId},${ref().environmentId},${ref().threadId})`;
    const input = { memorySpaceId: Fixture.space, memoryId: source.input.memoryId };
    const legacy = yield* service.read(input, Effect.void);
    expect(legacy).not.toHaveProperty("marks");
    const projected = yield* service.read({ ...input, includeMarks: true }, Effect.void);
    const marks = { provenance: "unverified", originThreadId: ref().threadId };
    expect(projected).toEqual({ ...legacy, marks });
    const list = yield* service.list(
      {
        memorySpaceId: input.memorySpaceId,
        includeQuarantined: false,
        limit: 10,
        includeMarks: true,
      },
      Effect.void,
    );
    expect(list.items).toEqual([projected]);
    const history = yield* service.history(
      { ...input, limit: 10, includeMarks: true },
      Effect.void,
    );
    expect(history.revisions[0]).toMatchObject({ marks });
  }).pipe(Effect.provide(Fixture.layer)),
);
