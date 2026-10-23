import { expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { McpServer } from "effect/ai";
import * as Sync from "../../../memory/MemorySyncService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import * as MemoryService from "../../../memory/MemoryService.ts";
import { decideMemoryOperation } from "../../../memory/MemoryDecider.ts";
import { scanMemoryValue } from "../../../memory/MemorySecretScanner.ts";
import { assertUsageCounters } from "../../../memory/MemoryUsageScan.testkit.ts";
import * as Store from "../../../memory/MemoryStore.ts";
import { MemoryToolkit } from "./tools.ts";
import { memoryError } from "./handlers.ts";
import * as Fixture from "./handlers.testkit.ts";
import * as Settings from "../../../serverSettings.ts";

const decodeReceipt = Schema.decodeUnknownEffect(M.MemoryMutationReceipt);
const decodePage = Schema.decodeUnknownEffect(M.MemoryPage);
const decodeHistory = Schema.decodeUnknownEffect(M.MemoryHistoryPage);
const encodeError = Schema.encodeSync(M.MemoryRpcError);

it("registers all nine core tools", () => {
  expect(Object.keys(MemoryToolkit.tools).sort()).toEqual([...M.MEMORY_MCP_TOOLS].sort());
  for (const tool of Object.values(MemoryToolkit.tools))
    expect(Tool.getJsonSchema(tool).type).toBe("object");
});
it.effect(
  "real toolkit writes, reads, searches with service cursor, lists, histories, forgets and refuses invalid revert",
  () =>
    Effect.gen(function* () {
      const created = yield* Fixture.call("memory_upsert", Fixture.upsert());
      expect((yield* decodeReceipt(created.body)).outcome).toBe("accepted");
      yield* assertUsageCounters;
      const service = yield* MemoryService.MemoryService;
      yield* service.upsert(
        { ...Fixture.upsert(21), memoryId: M.MemoryId.make(Fixture.id(20)) },
        Effect.void,
      );
      const query = {
        memorySpaceId: Fixture.space,
        query: "synthetic",
        mode: "substring" as const,
        limit: 1,
      };
      const direct = yield* service.search(query, Effect.void);
      expect(direct.nextCursor).not.toBeNull();
      expect((yield* Fixture.call("memory_search", query)).body).toEqual(direct);
      const continuation = { ...query, cursor: direct.nextCursor! };
      expect((yield* Fixture.call("memory_search", continuation)).body).toEqual(
        yield* service.search(continuation, Effect.void),
      );
      expect(
        (yield* decodePage(
          (yield* Fixture.call("memory_list", {
            memorySpaceId: Fixture.space,
            includeQuarantined: false,
            limit: 1,
          })).body,
        )).items,
      ).toHaveLength(1);
      expect(
        (yield* Fixture.call("memory_read", {
          memorySpaceId: Fixture.space,
          memoryId: Fixture.memoryId,
        })).body,
      ).toMatchObject({ status: "active", payload: { text: "synthetic memory" } });
      expect(
        (yield* decodeHistory(
          (yield* Fixture.call("memory_history", {
            memorySpaceId: Fixture.space,
            memoryId: Fixture.memoryId,
            limit: 1,
          })).body,
        )).revisions,
      ).toHaveLength(1);
      const read = yield* service.read(
        { memorySpaceId: Fixture.space, memoryId: Fixture.memoryId },
        Effect.void,
      );
      expect(
        (yield* Fixture.call("memory_forget", {
          memorySpaceId: Fixture.space,
          memoryId: Fixture.memoryId,
          operationId: M.MemoryOperationId.make(Fixture.id(4)),
          expectedHeads: read.status === "active" ? [read.revision.revisionId] : [],
        })).result.isError,
      ).not.toBe(true);
      expect(
        (yield* Fixture.call("memory_revert_resolution", {
          memorySpaceId: Fixture.space,
          operationId: M.MemoryOperationId.make(Fixture.id(5)),
          memoryId: Fixture.memoryId,
          resolutionId: M.MemoryResolutionId.make(Fixture.id(6)),
          restoredRevisionId: M.MemoryRevisionId.make(Fixture.id(7)),
          expectedHeads: [M.MemoryRevisionId.make(Fixture.id(8))],
        })).result.isError,
      ).toBe(true);
      expect((yield* Fixture.call("memory_sync_status", {})).body).toMatchObject({
        code: "hub_disabled",
      });
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect.each(M.MEMORY_MCP_TOOLS.filter((name) => name !== "memory_read_source"))(
  "denies ungranted %s at the registered toolkit",
  (name) =>
    Effect.gen(function* () {
      const input =
        name === "memory_upsert"
          ? Fixture.upsert()
          : name === "memory_list"
            ? { memorySpaceId: Fixture.space, includeQuarantined: false }
            : name === "memory_search"
              ? { memorySpaceId: Fixture.space, query: "synthetic" }
              : name === "memory_sync_status"
                ? {}
                : name === "memory_forget"
                  ? {
                      memorySpaceId: Fixture.space,
                      memoryId: Fixture.memoryId,
                      operationId: M.MemoryOperationId.make(Fixture.id(4)),
                      expectedHeads: [],
                    }
                  : name === "memory_revert_resolution"
                    ? {
                        memorySpaceId: Fixture.space,
                        memoryId: Fixture.memoryId,
                        operationId: M.MemoryOperationId.make(Fixture.id(5)),
                        resolutionId: M.MemoryResolutionId.make(Fixture.id(6)),
                        restoredRevisionId: M.MemoryRevisionId.make(Fixture.id(7)),
                        expectedHeads: [M.MemoryRevisionId.make(Fixture.id(8))],
                      }
                    : { memorySpaceId: Fixture.space, memoryId: Fixture.memoryId };
      expect((yield* Fixture.call(name, input, Fixture.scope([]))).body).toMatchObject({
        code: "unavailable",
      });
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect(
  "read-only refuses upsert despite stored write; a non-read-only explicit writer succeeds",
  () =>
    Effect.gen(function* () {
      const granted = Fixture.scope();
      expect(
        (yield* Fixture.call("memory_upsert", Fixture.upsert(), {
          ...granted,
          client: { ...granted.client!, access: "read-only" },
        })).result.isError,
      ).toBe(true);
      expect(
        (yield* Fixture.call("memory_upsert", Fixture.upsert(), { ...granted, readOnly: true }))
          .result.isError,
      ).toBe(true);
      expect(
        (yield* Fixture.call("memory_upsert", Fixture.upsert(), granted)).result.isError,
      ).not.toBe(true);
    }).pipe(Effect.provide(Fixture.layer)),
);

it("maps safe code and capacity without exposing causes or undefined", () => {
  for (const error of [
    new Store.MemoryStorageError({ stage: "test", cause: "synthetic private detail" }),
    new MemoryService.MemoryAccessError({ code: "fenced" }),
    new Store.MemoryCapacityError({ dimension: "body", current: 3, limit: 2 }),
  ]) {
    const safe = memoryError(error);
    expect(Object.values(safe).some((value) => value === undefined)).toBe(false);
    const encoded = encodeError(safe);
    expect(JSON.stringify(encoded)).not.toContain("synthetic private detail");
  }
  expect(
    memoryError(new Store.MemoryCapacityError({ dimension: "body", current: 3, limit: 2 }))
      .capacity,
  ).toMatchObject({ current: 3, limit: 2 });
});

it.effect("strict contract decoding rejects extra keys before persisting a raw MCP request", () =>
  Effect.gen(function* () {
    const result = yield* Fixture.call("memory_upsert", {
      ...Fixture.upsert(),
      unexpected: "synthetic",
    });
    expect(result.result.isError).toBe(true);
    const service = yield* MemoryService.MemoryService;
    expect(
      (yield* service.list(
        { memorySpaceId: Fixture.space, includeQuarantined: false, limit: 20 },
        Effect.void,
      )).items,
    ).toHaveLength(0);
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect(
  "revocation while a toolkit mutation waits for the real Store transaction prevents persistence",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const locked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let authorized = true;
      const observed = Layer.effect(
        MemoryService.MemoryService,
        Effect.gen(function* () {
          const delegate = yield* MemoryService.MemoryService;
          return MemoryService.MemoryService.of({
            ...delegate,
            upsert: (input, permit) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(delegate.upsert(input, permit)),
              ),
          });
        }),
      ).pipe(Layer.provideMerge(Fixture.core));
      const toolkit = McpHttpServer.layerMemoryToolkit.pipe(
        Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
        Layer.provideMerge(observed),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(Layer.mock(Sync.MemorySyncService)({})),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const holder = yield* store
          .transact(
            Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(locked);
        const invocation = {
          ...Fixture.scope(),
          reauthorize: () =>
            Effect.suspend(() =>
              authorized
                ? Effect.void
                : Effect.fail(
                    new M.EnvironmentAuthorizationError({
                      message: "Revoked.",
                      requiredScope: "memory:write",
                    }),
                  ),
            ),
        };
        const pending = yield* Fixture.call("memory_upsert", Fixture.upsert(), invocation).pipe(
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        authorized = false;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        expect((yield* Fiber.join(pending)).body).toMatchObject({ code: "unavailable" });
        const service = yield* MemoryService.MemoryService;
        expect(
          (yield* service.list(
            { memorySpaceId: Fixture.space, includeQuarantined: false, limit: 20 },
            Effect.void,
          )).items,
        ).toHaveLength(0);
      }).pipe(Effect.provide(toolkit));
    }).pipe(Effect.scoped),
);

const sourceFixture = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const environmentId = M.EnvironmentId.make("fixture-memory-mcp");
  const sourceThread = {
    environmentId: M.EnvironmentId.make("synthetic-owner"),
    threadId: M.ThreadId.make("synthetic-source"),
  };
  const watermark = {
    fromEventId: M.EventId.make("synthetic-from"),
    toEventId: M.EventId.make("synthetic-to"),
    throughSequence: 8,
  };
  const messageId = M.MessageId.make("synthetic-message");
  const operationId = M.MemoryOperationId.make(Fixture.id(9000));
  const revisionId = M.MemoryRevisionId.make(Fixture.id(9001));
  const op: M.MemoryOperation = {
    protocolVersion: 1,
    kind: "upsert",
    memorySpaceId: Fixture.space,
    memoryId: Fixture.memoryId,
    operationId,
    originEnvironmentId: environmentId,
    expectedHeads: [],
    revision: {
      memorySpaceId: Fixture.space,
      memoryId: Fixture.memoryId,
      operationId,
      revisionId,
      payloadRef: revisionId,
      parents: [],
      scope: { kind: "user" },
      assertionKind: "inference",
      createdAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
      provenance: { environmentId, sourceThread, sourceWatermark: watermark },
    },
    payload: {
      text: "synthetic linked summary",
      evidence: [{ origin: "thread", sourceThread, watermark, messageIds: [messageId] }],
      derivedFromMemoryRevisions: [],
    },
  };
  const aggregate = yield* store.loadAggregate(Fixture.space, Fixture.memoryId);
  yield* store.apply(decideMemoryOperation(aggregate, op, Store.localIntent, scanMemoryValue(op)));
  const input: M.MemoryReadSourceInput = {
    memorySpaceId: Fixture.space,
    memoryId: Fixture.memoryId,
    sourceThread,
    messageIds: [messageId],
    limit: 10,
  };
  const page: M.MemorySourcePage = {
    sourceThread,
    watermark,
    messages: [{ messageId, text: "synthetic original" }],
    nextCursor: null,
  };
  return { input, page };
});

it.effect(
  "source tool uses public service and fake owner authority, preserves page and independent scopes",
  () => {
    let calls = 0;
    return Effect.gen(function* () {
      const { input, page } = yield* sourceFixture;
      for (const scopes of [["memory:read"], ["orchestration:read"], []] as const) {
        const result = yield* Fixture.call("memory_read_source", input, Fixture.scope(scopes));
        expect(result.body).toMatchObject({ code: "unavailable" });
      }
      expect(calls).toBe(0);
      const full = { ...Fixture.scope(["memory:read", "orchestration:read"]), readOnly: true };
      const result = yield* Fixture.call("memory_read_source", input, full);
      expect(result.result.isError).not.toBe(true);
      expect(result.body).toEqual(page);
      expect(calls).toBe(1);
      expect(
        (yield* Fixture.call("memory_read_source", { ...input, sshHost: "synthetic" }, full)).body,
      ).toMatchObject({ code: "invalid_request" });
      expect(calls).toBe(1);
    }).pipe(
      Effect.provide(
        Fixture.layerWithSourceReadAuthority((validated, permit) =>
          permit.pipe(
            Effect.andThen(
              Effect.sync(() => {
                calls++;
                return {
                  kind: "available" as const,
                  page: {
                    sourceThread: validated.request.sourceThread,
                    watermark: validated.request.sourceWatermark,
                    messages: validated.request.messageIds.map((messageId) => ({
                      messageId,
                      text: "synthetic original",
                    })),
                    nextCursor: null,
                  },
                };
              }),
            ),
          ),
        ),
      ),
    );
  },
);

it.effect.each([
  "source_unavailable",
  "forgotten",
  "source_invalidated",
  "secret_detected",
  "denied",
  "capacity",
] as const)("source tool retains safe authority outcome %s", (kind) =>
  Effect.gen(function* () {
    const { input } = yield* sourceFixture;
    const result = yield* Fixture.call(
      "memory_read_source",
      input,
      Fixture.scope(["memory:read", "orchestration:read"]),
    );
    expect(result.result.isError).toBe(true);
    expect(result.body).toMatchObject({
      code: kind === "denied" ? "unavailable" : kind === "capacity" ? "capacity_exceeded" : kind,
    });
    if (kind === "capacity")
      expect(result.body).toMatchObject({
        capacity: { dimension: "body", current: 3, limit: 2, reclaimable: 7 },
      });
    expect(JSON.stringify(result.body)).not.toContain("cause");
  }).pipe(
    Effect.provide(
      Fixture.layerWithSourceReadAuthority(() =>
        kind === "capacity"
          ? Effect.fail(
              new M.MemoryHubError({
                code: "capacity_exceeded",
                capacity: {
                  code: "capacity_exceeded",
                  dimension: "body",
                  current: 3,
                  limit: 2,
                  reclaimable: 7,
                },
              }),
            )
          : Effect.succeed(
              kind === "denied"
                ? { kind: "denied" as const, requiredPermission: "orchestration:read" as const }
                : { kind: "unavailable" as const, code: kind },
            ),
      ),
    ),
  ),
);

it.effect("source tool stays closed without owner authority despite explicit scopes", () =>
  Effect.gen(function* () {
    const { input } = yield* sourceFixture;
    expect(
      (yield* Fixture.call(
        "memory_read_source",
        input,
        Fixture.scope(["memory:read", "orchestration:read"]),
      )).body,
    ).toMatchObject({ code: "unavailable" });
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect.each(["grantedScopes", "reauthorize", "both"] as const)(
  "missing optional invocation authority %s never means default memory permission",
  (missing) =>
    Effect.gen(function* () {
      const scope = { ...Fixture.scope(["memory:read", "memory:write", "orchestration:read"]) };
      if (missing !== "reauthorize") delete scope.grantedScopes;
      if (missing !== "grantedScopes") delete scope.reauthorize;
      const { input } = yield* sourceFixture;
      for (const [name, request] of [
        ["memory_list", { memorySpaceId: Fixture.space, includeQuarantined: false }],
        ["memory_upsert", Fixture.upsert()],
        ["memory_read_source", input],
      ] as const)
        expect((yield* Fixture.call(name, request, scope)).body).toMatchObject({
          code: "unavailable",
        });
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("r4 tracked MCP writes inherit injected context and forget purges them", () =>
  Effect.gen(function* () {
    const service = yield* MemoryService.MemoryService;
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events(application_event_version INTEGER,aggregate_kind TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT)`;
    const caller = {
      ...Fixture.scope(),
      thread: {
        threadId: M.ThreadId.make("mcp-lineage"),
        providerSessionId: "synthetic",
        providerInstanceId: M.ProviderInstanceId.make("codex"),
      },
      client: undefined,
    };
    const a = Fixture.upsert(15000);
    yield* service.upsert(a, Effect.void);
    const rA = (yield* store.loadAggregate(Fixture.space, a.memoryId)).heads[0]!;
    yield* store.appendThreadLineage(
      { environmentId: caller.environmentId, threadId: caller.thread.threadId },
      Fixture.space,
      [rA],
    );
    const s = { ...Fixture.upsert(15001), memoryId: M.MemoryId.make(Fixture.id(15002)) };
    const result = yield* Fixture.call("memory_upsert", s, caller);
    expect(result.result.isError).not.toBe(true);
    const saved = yield* store.loadAggregate(Fixture.space, s.memoryId);
    expect(
      saved.revisions.find((p) => p.revision.revisionId === saved.heads[0])?.payload
        ?.derivedFromMemoryRevisions,
    ).toEqual([rA]);
    yield* service.forget(
      {
        memorySpaceId: Fixture.space,
        memoryId: a.memoryId,
        operationId: M.MemoryOperationId.make(Fixture.id(15003)),
        expectedHeads: [rA],
      },
      Effect.void,
    );
    expect(yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${s.memoryId}`).toHaveLength(0);
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect(
  "r5 source text records the locator revision before returning, and recording failure withholds text",
  () =>
    Effect.gen(function* () {
      const { input, page } = yield* sourceFixture;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      yield* sql`CREATE TABLE orchestration_events(application_event_version INTEGER,aggregate_kind TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT)`;
      const invocation = {
        ...Fixture.scope(["memory:read", "orchestration:read"]),
        client: undefined,
        thread: {
          threadId: M.ThreadId.make("source-consumer"),
          providerSessionId: "synthetic",
          providerInstanceId: M.ProviderInstanceId.make("codex"),
        },
      };
      const failedCaller = {
        ...invocation,
        thread: { ...invocation.thread, threadId: M.ThreadId.make("failed-source-consumer") },
      };
      expect((yield* Fixture.call("memory_read_source", input, invocation)).body).toEqual(page);
      expect(
        (yield* store.readThreadLineage(
          { environmentId: invocation.environmentId, threadId: invocation.thread.threadId },
          Fixture.space,
        )).revisions,
      ).toEqual((yield* store.loadAggregate(Fixture.space, input.memoryId)).heads);
      yield* sql`CREATE TRIGGER fail_lineage BEFORE INSERT ON memory_outbox WHEN NEW.space='_worker' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`;
      const failed = yield* Fixture.call("memory_read_source", input, failedCaller);
      expect(failed.result.isError).toBe(true);
      expect(JSON.stringify(failed.body)).not.toContain("synthetic original");
    }).pipe(
      Effect.provide(
        Fixture.layerWithSourceReadAuthority((validated) =>
          Effect.succeed({
            kind: "available",
            page: {
              sourceThread: validated.request.sourceThread,
              watermark: validated.request.sourceWatermark,
              messages: [
                { messageId: validated.request.messageIds[0]!, text: "synthetic original" },
              ],
              nextCursor: null,
            },
          }),
        ),
      ),
    ),
);

it.effect.each([
  { profile: "observer", enabled: true, denied: true },
  { profile: "worker", enabled: true, denied: false },
  { profile: "manager", enabled: true, denied: false },
  { profile: "observer", enabled: false, denied: false },
])("memory writes respect the effective goatclaw profile: %j", ({ profile, enabled, denied }) =>
  Effect.gen(function* () {
    const caller = yield* Fixture.bindProfile(profile);
    if (!enabled) {
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ goatclaw: { enabled: false } });
    }
    const service = yield* MemoryService.MemoryService;
    yield* service.upsert(Fixture.upsert(), Effect.void);
    const readInput = { memorySpaceId: Fixture.space, memoryId: Fixture.memoryId };
    const read = yield* Fixture.call("memory_read", readInput, caller);
    expect(read.result.isError).not.toBe(true);
    expect(read.body).toMatchObject({ status: "active" });
    const stored = yield* service.read(readInput, Effect.void);
    const store = yield* Store.MemoryStore;
    const before = yield* store.loadAggregate(Fixture.space, Fixture.memoryId);
    const expectedHeads = stored.status === "active" ? [stored.revision.revisionId] : [];
    const update = yield* Fixture.call(
      "memory_upsert",
      {
        ...Fixture.upsert(4),
        expectedHeads,
        payload: { text: "updated synthetic memory", evidence: [], derivedFromMemoryRevisions: [] },
      },
      caller,
    );
    if (!denied) expect(update.result.isError).not.toBe(true);
    const latest = yield* service.read(readInput, Effect.void);
    const forgotten = yield* Fixture.call(
      "memory_forget",
      {
        ...readInput,
        operationId: M.MemoryOperationId.make(Fixture.id(8)),
        expectedHeads: latest.status === "active" ? [latest.revision.revisionId] : [],
      },
      caller,
    );
    if (denied) {
      expect(forgotten.body).toMatchObject({ code: "capability_denied" });
      expect(update.body).toMatchObject({ code: "capability_denied" });
      const reverted = yield* Fixture.call(
        "memory_revert_resolution",
        {
          ...readInput,
          operationId: M.MemoryOperationId.make(Fixture.id(5)),
          resolutionId: M.MemoryResolutionId.make(Fixture.id(6)),
          restoredRevisionId: M.MemoryRevisionId.make(Fixture.id(7)),
          expectedHeads,
        },
        caller,
      );
      expect(reverted.body).toMatchObject({ code: "capability_denied" });
      expect(yield* service.read(readInput, Effect.void)).toEqual(stored);
      expect(yield* store.loadAggregate(Fixture.space, Fixture.memoryId)).toEqual(before);
      for (const operation of [4, 5, 8])
        expect(
          yield* store.receipt(Fixture.space, M.MemoryOperationId.make(Fixture.id(operation))),
        ).toBeFalsy();
    } else {
      expect(forgotten.result.isError).not.toBe(true);
      expect(yield* service.read(readInput, Effect.void)).toMatchObject({ status: "forgotten" });
    }
  }).pipe(Effect.provide(Fixture.layerWithProfiles)),
);

it.effect.each(["live", "ceiling", "missing"] as const)(
  "memory write admission respects %s profile authority",
  (change) =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const policy = (yield* settings.getSettings).goatclaw;
      const worker = policy.profiles.worker!;
      const narrowed = { ...worker, capabilities: [] };
      if (change === "ceiling")
        yield* settings.updateSettings({
          goatclaw: { profiles: { ...policy.profiles, worker: narrowed } },
        });
      const caller = yield* Fixture.bindProfile("worker");
      const service = yield* MemoryService.MemoryService;
      yield* service.upsert(Fixture.upsert(), Effect.void);
      if (change === "live") {
        const initial = yield* service.read(
          { memorySpaceId: Fixture.space, memoryId: Fixture.memoryId },
          Effect.void,
        );
        expect(
          (yield* Fixture.call(
            "memory_upsert",
            {
              ...Fixture.upsert(9),
              expectedHeads: initial.status === "active" ? [initial.revision.revisionId] : [],
            },
            caller,
          )).result.isError,
        ).not.toBe(true);
        yield* settings.updateSettings({
          goatclaw: { profiles: { ...policy.profiles, worker: narrowed } },
        });
      } else if (change === "ceiling") {
        yield* settings.updateSettings({ goatclaw: { profiles: policy.profiles } });
      } else {
        const { worker: _worker, ...remaining } = policy.profiles;
        yield* settings.updateSettings({
          goatclaw: { defaultProfile: "observer", profiles: remaining },
        });
      }
      const input = { memorySpaceId: Fixture.space, memoryId: Fixture.memoryId };
      const before = yield* service.read(input, Effect.void);
      const result = yield* Fixture.call(
        "memory_forget",
        {
          ...input,
          operationId: M.MemoryOperationId.make(Fixture.id(4)),
          expectedHeads: before.status === "active" ? [before.revision.revisionId] : [],
        },
        caller,
      );
      expect(result.result.isError).toBe(true);
      expect(result.body).toMatchObject({ code: "capability_denied" });
      expect((yield* Fixture.call("memory_read", input, caller)).body).toEqual(before);
    }).pipe(Effect.provide(Fixture.layerWithProfiles)),
);

it.effect(
  "outside memory clients retain their grants with goatclaw's default observer profile",
  () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ goatclaw: { defaultProfile: "observer" } });
      expect((yield* Fixture.call("memory_upsert", Fixture.upsert())).result.isError).not.toBe(
        true,
      );
      const service = yield* MemoryService.MemoryService;
      const input = { memorySpaceId: Fixture.space, memoryId: Fixture.memoryId };
      const before = yield* service.read(input, Effect.void);
      expect(
        (yield* Fixture.call("memory_forget", {
          ...input,
          operationId: M.MemoryOperationId.make(Fixture.id(4)),
          expectedHeads: before.status === "active" ? [before.revision.revisionId] : [],
        })).result.isError,
      ).not.toBe(true);
      expect(yield* service.read(input, Effect.void)).toMatchObject({ status: "forgotten" });
    }).pipe(Effect.provide(Fixture.layerWithProfiles)),
);
