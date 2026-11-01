import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { MEMORY_REPORT_DETAIL_RETENTION_MS } from "@goat/contracts";
import * as Worker from "./MemoryReportWorker.ts";
import * as Adapter from "./MemoryReportAdapter.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import { botMessages, environmentId, setupBot } from "../channels/testkit/ChannelHarness.ts";
import {
  insertReport,
  makeReportHarness,
  reportId,
  reportRows,
  space,
} from "./testkit/MemoryReportHarness.ts";

const makeWorker = Layer.build(Layer.fresh(Worker.layer)).pipe(
  Effect.map((context) => Context.get(context, Worker.MemoryReportWorker)),
);

describe("MemoryReportWorker", () => {
  it.effect.each(["drain", "start"])(
    "serializes a pre-start drain against another %s",
    (contender) => {
      const harness = makeReportHarness();
      return Effect.gen(function* () {
        yield* TestClock.setTime(0);
        yield* setupBot;
        yield* insertReport(1);
        yield* insertReport(2);
        const adapter = yield* Adapter.MemoryReportAdapter;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let active = 0;
        let maximum = 0;
        let calls = 0;
        const worker = yield* makeWorker.pipe(
          Effect.provideService(Adapter.MemoryReportAdapter, {
            deliver: (report) =>
              Effect.gen(function* () {
                active++;
                maximum = Math.max(maximum, active);
                calls++;
                if (calls === 1) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
                return yield* adapter.deliver(report);
              }).pipe(Effect.ensuring(Effect.sync(() => active--))),
          }),
        );
        const first = yield* worker.drain.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const second = yield* (contender === "drain" ? worker.drain : worker.start()).pipe(
          Effect.forkScoped,
        );
        // Advancing by zero waits for runnable fibers to suspend: the competing pass
        // must reach either the shared permit or its adapter before release.
        yield* TestClock.adjust(0);
        const maximumWhileBlocked = maximum;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        yield* worker.drain;
        assert.strictEqual(maximumWhileBlocked, 1);
        assert.strictEqual(maximum, 1);
        assert.strictEqual(active, 0);
        assert.strictEqual(calls, 2);
        assert.deepStrictEqual(yield* reportRows, [
          { state: "delivered", automatic_attempts: 1, claimed_until: null },
          { state: "delivered", automatic_attempts: 1, claimed_until: null },
        ]);
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT key FROM memory_import_keys WHERE key_kind='report_delivered' ORDER BY key`,
          [{ key: reportId(1) }, { key: reportId(2) }],
        );
        const timeline = yield* botMessages;
        assert.strictEqual(timeline.messages.length, 2);
        assert.strictEqual(new Set(timeline.messages.map((message) => message.id)).size, 2);
        assert.isEmpty(timeline.runs);
        assert.isEmpty(harness.providerCalls);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect.each(["due", "lease"])("delivers at %s without an unrelated commit", (reason) => {
    const harness = makeReportHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(0);
      yield* setupBot;
      yield* insertReport();
      const sql = yield* SqlClient.SqlClient;
      const service = yield* Service.MemoryService;
      const adapter = yield* Adapter.MemoryReportAdapter;
      const committed = yield* Deferred.make<void>();
      if (reason === "due") yield* sql`UPDATE memory_report_outbox SET next_attempt_at=60000`;
      else yield* service.acquireReports({ owner: environmentId, now: 0, until: 60_000, limit: 1 });
      const worker = yield* makeWorker.pipe(
        Effect.provideService(Adapter.MemoryReportAdapter, {
          deliver: (report) =>
            adapter.deliver(report).pipe(Effect.tap(() => Deferred.succeed(committed, undefined))),
        }),
      );
      yield* worker.start();
      yield* worker.drain;
      assert.isEmpty((yield* botMessages).messages);
      yield* TestClock.adjust(60_000);
      yield* Deferred.await(committed);
      yield* worker.drain;
      assert.strictEqual((yield* reportRows)[0]!.state, "delivered");
      assert.strictEqual((yield* botMessages).messages.length, 1);
      assert.isEmpty(harness.providerCalls);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("post-commit Store wake starts a newly admitted report", () => {
    const harness = makeReportHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(0);
      yield* setupBot;
      const store = yield* Store.MemoryStore;
      const adapter = yield* Adapter.MemoryReportAdapter;
      const committed = yield* Deferred.make<void>();
      const worker = yield* makeWorker.pipe(
        Effect.provideService(Adapter.MemoryReportAdapter, {
          deliver: (report) =>
            adapter.deliver(report).pipe(Effect.tap(() => Deferred.succeed(committed, undefined))),
        }),
      );
      yield* worker.start();
      yield* worker.drain;
      // Settings retry reset is a real post-commit wake producer; no manual worker drain.
      yield* insertReport();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE memory_report_outbox SET automatic_attempts=10,attempts_known=1,state='failed',failure_code='unavailable'`;
      yield* store.transact(
        store.resetReportAttemptsTx(
          { memorySpaceId: space, environmentId, reportIds: [reportId()] },
          0,
        ),
      );
      yield* Deferred.await(committed);
      yield* worker.drain;
      assert.strictEqual((yield* reportRows)[0]!.state, "delivered");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("ack crash and worker restart reuse one committed timeline record", () => {
    const harness = makeReportHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(0);
      yield* setupBot;
      yield* insertReport();
      const adapter = yield* Adapter.MemoryReportAdapter;
      const committed = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const crashed = yield* makeWorker.pipe(
            Effect.provideService(Adapter.MemoryReportAdapter, {
              deliver: (report) =>
                adapter.deliver(report).pipe(
                  Effect.tap(() => Deferred.succeed(committed, undefined)),
                  Effect.andThen(Effect.never),
                ),
            }),
          );
          yield* crashed.start();
          yield* Deferred.await(committed);
        }),
      );
      assert.strictEqual((yield* reportRows)[0]!.state, "pending");
      yield* TestClock.adjust(60_000);
      const restarted = yield* makeWorker;
      yield* restarted.start();
      yield* restarted.drain;
      assert.deepStrictEqual(yield* reportRows, [
        { state: "delivered", automatic_attempts: 2, claimed_until: null },
      ]);
      assert.strictEqual((yield* botMessages).messages.length, 1);
      assert.isEmpty(harness.providerCalls);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect(
    "tenth lease crash expires on its timer, stops wakes and never calls an eleventh adapter",
    () => {
      const harness = makeReportHarness();
      return Effect.gen(function* () {
        yield* TestClock.setTime(0);
        yield* setupBot;
        yield* insertReport();
        const sql = yield* SqlClient.SqlClient;
        const service = yield* Service.MemoryService;
        const adapter = yield* Adapter.MemoryReportAdapter;
        yield* sql`UPDATE memory_report_outbox SET automatic_attempts=9`;
        const committed = yield* Deferred.make<void>();
        let calls = 0;
        const counted = {
          deliver: (report: Parameters<typeof adapter.deliver>[0]) => {
            calls++;
            return adapter.deliver(report);
          },
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const crashed = yield* makeWorker.pipe(
              Effect.provideService(Adapter.MemoryReportAdapter, {
                deliver: (report) =>
                  counted.deliver(report).pipe(
                    Effect.tap(() => Deferred.succeed(committed, undefined)),
                    Effect.andThen(Effect.never),
                  ),
              }),
            );
            yield* crashed.start();
            yield* Deferred.await(committed);
          }),
        );
        const normalized = yield* Deferred.make<void>();
        let normalizations = 0;
        const restarted = yield* makeWorker.pipe(
          Effect.provideService(Adapter.MemoryReportAdapter, counted),
          Effect.provideService(Service.MemoryService, {
            ...service,
            normalizeExpiredReports: (now) =>
              service.normalizeExpiredReports(now).pipe(
                Effect.tap(() => {
                  normalizations++;
                  return now === 60_000 ? Deferred.succeed(normalized, undefined) : Effect.void;
                }),
              ),
          }),
        );
        yield* restarted.start();
        yield* restarted.drain;
        yield* TestClock.adjust(60_000);
        yield* Deferred.await(normalized);
        yield* restarted.drain;
        assert.deepStrictEqual(yield* reportRows, [
          { state: "failed", automatic_attempts: 10, claimed_until: null },
        ]);
        assert.isNull(yield* service.nextReportWakeAt(60_000));

        const settled = normalizations;
        yield* TestClock.adjust(600_000);
        assert.strictEqual(normalizations, settled);
        assert.strictEqual(calls, 1);
        assert.isEmpty(harness.providerCalls);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect.each(["ack", "defer"])(
    "stale %s leaves replacement lease and accounting unchanged",
    (action) => {
      const harness = makeReportHarness();
      return Effect.gen(function* () {
        yield* TestClock.setTime(0);
        yield* setupBot;
        yield* insertReport();
        const sql = yield* SqlClient.SqlClient;
        const service = yield* Service.MemoryService;
        const adapter = yield* Adapter.MemoryReportAdapter;
        let before: unknown;
        const counters = sql`SELECT space,dimension,scope_key,value FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
        const worker = yield* makeWorker.pipe(
          Effect.provideService(Adapter.MemoryReportAdapter, {
            deliver: (report) =>
              Effect.gen(function* () {
                const result = yield* adapter.deliver(report);
                yield* TestClock.adjust(60_000);
                yield* service.acquireReports({
                  owner: environmentId,
                  now: 60_000,
                  until: 120_000,
                  limit: 1,
                });
                before = yield* counters;
                if (action === "defer")
                  return yield* new Adapter.MemoryReportAdapterError({ code: "unavailable" });
                return result;
              }),
          }),
        );
        yield* worker.start();
        yield* worker.drain;
        assert.deepStrictEqual(yield* reportRows, [
          { state: "pending", automatic_attempts: 2, claimed_until: 120_000 },
        ]);
        assert.deepStrictEqual(yield* counters, before);
        assert.isEmpty(
          yield* sql`SELECT key FROM memory_import_keys WHERE key_kind='report_delivered'`,
        );
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect("delivery failure defers with backoff and retries from its own timer", () => {
    const harness = makeReportHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(0);
      yield* setupBot;
      yield* insertReport();
      const adapter = yield* Adapter.MemoryReportAdapter;
      const committed = yield* Deferred.make<void>();
      let calls = 0;
      const worker = yield* makeWorker.pipe(
        Effect.provideService(Adapter.MemoryReportAdapter, {
          deliver: (report) =>
            ++calls === 1
              ? Effect.fail(new Adapter.MemoryReportAdapterError({ code: "unavailable" }))
              : adapter
                  .deliver(report)
                  .pipe(Effect.tap(() => Deferred.succeed(committed, undefined))),
        }),
      );
      yield* worker.start();
      yield* worker.drain;
      assert.strictEqual((yield* reportRows)[0]!.state, "failed");
      yield* TestClock.adjust(30_000);
      yield* Deferred.await(committed);
      yield* worker.drain;
      assert.strictEqual((yield* reportRows)[0]!.state, "delivered");
      assert.strictEqual(calls, 2);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect.each([false, true])(
    "purges delivered detail at exactly 30 days with guard and manual rows retained (hub=%s)",
    (hub) => {
      const harness = makeReportHarness(hub);
      return Effect.gen(function* () {
        yield* TestClock.setTime(0);
        yield* setupBot;
        yield* insertReport();
        const sql = yield* SqlClient.SqlClient;
        const service = yield* Service.MemoryService;
        const purged = yield* Deferred.make<void>();
        const worker = yield* makeWorker.pipe(
          Effect.provideService(Service.MemoryService, {
            ...service,
            purgeDeliveredReportDetails: (input) =>
              service
                .purgeDeliveredReportDetails(input)
                .pipe(Effect.tap(() => Deferred.succeed(purged, undefined))),
          }),
        );
        yield* worker.start();
        yield* worker.drain;
        yield* insertReport(2, "failed");
        yield* insertReport(3);
        yield* sql`UPDATE memory_report_outbox SET automatic_attempts=10,state='failed',failure_code='unavailable' WHERE report_id!=${reportId()}`;
        yield* worker.drain;
        const guards =
          yield* sql`SELECT key,record_json FROM memory_import_keys WHERE key_kind='report_delivered'`;
        yield* TestClock.adjust(MEMORY_REPORT_DETAIL_RETENTION_MS - 1);
        assert.strictEqual((yield* reportRows).length, 3);
        yield* TestClock.adjust(1);
        yield* Deferred.await(purged);
        yield* worker.drain;
        assert.deepStrictEqual(yield* reportRows, [
          { state: "failed", automatic_attempts: 10, claimed_until: null },
          { state: "failed", automatic_attempts: 10, claimed_until: null },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT key,record_json FROM memory_import_keys WHERE key_kind='report_delivered'`,
          guards,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT dimension,value FROM memory_quota_counters WHERE dimension IN ('report_items','report_all_rows') ORDER BY dimension`,
          [
            { dimension: "report_all_rows", value: 2 },
            { dimension: "report_items", value: 2 },
          ],
        );
        assert.isNotNull(yield* service.readReportTarget(reportId()));
        assert.strictEqual((yield* botMessages).messages.length, 1);
        assert.isEmpty(harness.providerCalls);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );
});
