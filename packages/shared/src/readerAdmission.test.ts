import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";
import * as SqliteClient from "./nodeSqliteClient.ts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import {
  failFastReaderAdmission,
  makeReaderAdmission,
  ReaderAdmissionClosedError,
  readerAdmissionTimeout,
} from "./readerAdmission.ts";
import { isReaderAdmissionOverload } from "./readerAdmissionOverload.ts";

const make = (timeout: Duration.Duration | null = Duration.seconds(30)) =>
  makeReaderAdmission({ limit: 1, timeout, honorFailFast: true });

it.effect("grants queued readers FIFO", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* make();
      yield* gate.acquire();
      const a = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
      const b = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
      assert.isUndefined(a.pollUnsafe());
      assert.isUndefined(b.pollUnsafe());
      yield* gate.release;
      yield* Fiber.join(a);
      assert.isUndefined(b.pollUnsafe());
      yield* gate.release;
      yield* Fiber.join(b);
      yield* gate.release;
    }),
  ),
);

it.effect("expires exactly at its deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* make(Duration.seconds(1));
      yield* gate.acquire();
      const waiter = yield* Effect.forkChild(Effect.result(gate.acquire()), {
        startImmediately: true,
      });
      yield* TestClock.adjust("999 millis");
      assert.isUndefined(waiter.pollUnsafe());
      yield* TestClock.adjust("1 millis");
      const result = yield* Fiber.join(waiter);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.isTrue(isReaderAdmissionOverload(result.failure));
      yield* gate.release;
    }),
  ),
);

it.effect("zero timeout admits free capacity and rejects saturation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* make(Duration.zero);
      yield* gate.acquire();
      const error = yield* Effect.flip(gate.acquire());
      assert.isTrue(isReaderAdmissionOverload(error));
      yield* gate.release;
      yield* gate.acquire();
      yield* gate.release;
    }),
  ),
);

it.effect("cancelling a waiter leaves the next reader eligible", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* make();
      yield* gate.acquire();
      const a = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
      const b = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
      yield* Fiber.interrupt(a);
      yield* gate.release;
      yield* Fiber.join(b);
      yield* gate.release;
    }),
  ),
);

it.effect("fail fast does not enter the queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* make();
      yield* gate.acquire();
      const error = yield* failFastReaderAdmission(gate.acquire()).pipe(Effect.flip);
      assert.isTrue(isReaderAdmissionOverload(error));
      yield* gate.release;
      yield* gate.acquire();
      yield* gate.release;
    }),
  ),
);

it.effect("deadline expires an uninterruptible waiter", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* make(Duration.seconds(1));
      yield* gate.acquire();
      const waiter = yield* Effect.forkChild(
        gate.acquire().pipe(Effect.uninterruptible, Effect.result),
        { startImmediately: true },
      );
      assert.isUndefined(waiter.pollUnsafe());
      yield* TestClock.adjust("1 seconds");
      const result = yield* Fiber.join(waiter);
      assert.equal(result._tag, "Failure");
      yield* gate.release;
    }),
  ),
);

it.effect("closing the gate fails queued and uninterruptible waiters as closed", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const gate = yield* Scope.provide(make(), scope);
    yield* gate.acquire();
    const a = yield* Effect.forkChild(gate.acquire().pipe(Effect.result), {
      startImmediately: true,
    });
    const b = yield* Effect.forkChild(gate.acquire().pipe(Effect.uninterruptible, Effect.result), {
      startImmediately: true,
    });
    yield* Scope.close(scope, Exit.void);
    for (const fiber of [a, b]) {
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ReaderAdmissionClosedError);
        assert.isFalse(isReaderAdmissionOverload(result.failure));
      }
    }
    yield* gate.release;
  }),
);

it.effect("skips an expired waiter at handoff even before its timer runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let now = 0n;
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => 0,
        currentTimeMillis: Effect.succeed(0),
        currentTimeNanosUnsafe: () => 0n,
        currentTimeNanos: Effect.succeed(0n),
        monotonicTimeNanosUnsafe: () => now,
        monotonicTimeNanos: Effect.sync(() => now),
        sleep: () => Effect.never,
      };
      const gate = yield* make(Duration.seconds(1));
      yield* gate.acquire();
      const first = yield* Effect.forkChild(
        gate.acquire().pipe(Effect.provideService(Clock.Clock, clock), Effect.result),
        { startImmediately: true },
      );
      now = 500_000_000n;
      const second = yield* Effect.forkChild(
        gate.acquire().pipe(Effect.provideService(Clock.Clock, clock), Effect.result),
        { startImmediately: true },
      );
      now = 1_000_000_000n;
      yield* gate.release;
      const expired = yield* Fiber.join(first);
      assert.equal(expired._tag, "Failure");
      if (expired._tag === "Failure") assert.isTrue(isReaderAdmissionOverload(expired.failure));
      assert.equal((yield* Fiber.join(second))._tag, "Success");
      yield* gate.release;
    }),
  ),
);

it.effect("interrupting a granted waiter passes its token to the next waiter", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let paused = false;
      const tasks: Array<() => void> = [];
      const scheduler: Scheduler.Scheduler = {
        executionMode: "async",
        shouldYield: () => paused,
        makeDispatcher: () => ({
          scheduleTask: (task) => {
            tasks.push(task);
          },
          flush: () => {},
        }),
      };
      const gate = yield* make();
      yield* gate.acquire();
      const first = yield* Effect.forkChild(
        gate.acquire().pipe(Effect.provideService(Scheduler.Scheduler, scheduler)),
        { startImmediately: true },
      );
      const second = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
      paused = true;
      yield* gate.release;
      assert.isUndefined(first.pollUnsafe());
      first.interruptUnsafe();
      paused = false;
      for (const task of tasks.splice(0)) task();
      yield* Fiber.await(first);
      yield* Fiber.join(second);
      yield* gate.release;
    }),
  ),
);

it.effect("a grant before the deadline remains owned when the reader resumes after it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let paused = false;
      const tasks: Array<() => void> = [];
      const scheduler: Scheduler.Scheduler = {
        executionMode: "async",
        shouldYield: () => paused,
        makeDispatcher: () => ({
          scheduleTask: (task) => {
            tasks.push(task);
          },
          flush: () => {},
        }),
      };
      const gate = yield* make(Duration.seconds(1));
      yield* gate.acquire();
      const waiter = yield* Effect.forkChild(
        gate.acquire().pipe(Effect.provideService(Scheduler.Scheduler, scheduler), Effect.result),
        { startImmediately: true },
      );
      yield* TestClock.adjust("999 millis");
      paused = true;
      yield* gate.release;
      assert.isUndefined(waiter.pollUnsafe());
      yield* TestClock.adjust("2 millis");
      assert.isUndefined(waiter.pollUnsafe());
      paused = false;
      for (const task of tasks.splice(0)) task();
      assert.equal((yield* Fiber.join(waiter))._tag, "Success");
      yield* gate.release;
      yield* gate.acquire();
      yield* gate.release;
    }),
  ),
);

it.effect("settled timers cannot expire a later owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* make(Duration.seconds(1));
      yield* gate.acquire();
      const cancelled = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
      yield* Fiber.interrupt(cancelled);
      const granted = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
      yield* gate.release;
      yield* Fiber.join(granted);
      yield* TestClock.adjust("1 seconds");
      const next = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
      assert.isUndefined(next.pollUnsafe());
      yield* gate.release;
      yield* Fiber.join(next);
      yield* gate.release;
    }),
  ),
);

it.effect("interrupts a timer when the waiter is granted before its handle is stored", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* make(Duration.seconds(1));
      const stopped = yield* Deferred.make<void>();
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => 0,
        currentTimeMillis: Effect.succeed(0),
        currentTimeNanosUnsafe: () => 0n,
        currentTimeNanos: Effect.succeed(0n),
        monotonicTimeNanosUnsafe: () => 0n,
        monotonicTimeNanos: Effect.succeed(0n),
        sleep: () =>
          gate.release.pipe(
            Effect.andThen(Effect.never),
            Effect.onExit(() => Deferred.succeed(stopped, undefined)),
          ),
      };
      yield* gate.acquire();
      yield* gate.acquire().pipe(Effect.provideService(Clock.Clock, clock));
      yield* Deferred.await(stopped);
      yield* gate.release;
      yield* gate.acquire();
      yield* gate.release;
    }),
  ),
);

it.effect("rejects invalid admission timeout inputs", () =>
  Effect.sync(() => {
    for (const input of [
      -1,
      Number.NaN,
      Infinity,
      -Infinity,
      [Number.NaN, 0] as const,
      { seconds: Number.NaN },
    ]) {
      assert.throws(() => readerAdmissionTimeout(input));
    }
    assert.equal(Duration.toMillis(readerAdmissionTimeout(0)), 0);
    assert.equal(Duration.toMillis(readerAdmissionTimeout()), 30_000);
  }),
);

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      startedWorkers.push(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const withReaderClient = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
  config: Partial<SqliteClient.SqliteClientConfig> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-admission-" });
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          filename: path.join(directory, "state.sqlite"),
          readerWorker: true,
          ...config,
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

it.effect.each(["statement", "transaction"] as const)(
  "cancels a pending admission without leaking capacity: %s",
  (shape) =>
    withReaderClient(
      (sql) =>
        Effect.gen(function* () {
          yield* countEntries(sql).pipe(SqliteClient.readOnly);
          const worker = startedWorkers.at(-1)!;
          using held = vi.spyOn(worker, "postMessage").mockImplementation(() => {});
          const reads = [];
          for (let i = 0; i < 64; i++)
            reads.push(
              yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
                startImmediately: true,
              }),
            );
          const pending = yield* Effect.forkChild(
            (shape === "statement"
              ? countEntries(sql)
              : sql.withTransaction(countEntries(sql))
            ).pipe(SqliteClient.readOnly, Effect.result),
            { startImmediately: true },
          );
          assert.isUndefined(pending.pollUnsafe());
          yield* Fiber.interrupt(pending);
          for (const read of reads) yield* Fiber.interrupt(read);
          held.mockRestore();
          yield* TestClock.adjust("250 millis");
          yield* countEntries(sql).pipe(SqliteClient.readOnly);
          using _heldAgain = vi
            .spyOn(startedWorkers.at(-1)!, "postMessage")
            .mockImplementation(() => {});
          const refill = [];
          for (let i = 0; i < 64; i++) {
            const read = yield* Effect.forkChild(
              countEntries(sql).pipe(SqliteClient.readOnly, Effect.result),
              { startImmediately: true },
            );
            assert.isUndefined(read.pollUnsafe());
            refill.push(read);
          }
          for (const read of refill) yield* Fiber.interrupt(read);
        }),
      { readerPoolSize: 1 },
    ),
);

it.effect("expires uninterruptible reader admission at its deadline", () =>
  withReaderClient(
    (sql) =>
      Effect.gen(function* () {
        yield* countEntries(sql).pipe(SqliteClient.readOnly);
        using _held = vi.spyOn(startedWorkers.at(-1)!, "postMessage").mockImplementation(() => {});
        const reads = [];
        for (let i = 0; i < 64; i++)
          reads.push(
            yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
              startImmediately: true,
            }),
          );
        const pending = yield* Effect.forkChild(
          countEntries(sql).pipe(SqliteClient.readOnly, Effect.uninterruptible, Effect.result),
          { startImmediately: true },
        );
        assert.isUndefined(pending.pollUnsafe());
        yield* TestClock.adjust("30 seconds");
        const result = yield* Fiber.join(pending);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.isTrue(SqliteClient.isReaderAdmissionOverload(result.failure));
        for (const read of reads) yield* Fiber.interrupt(read);
      }),
    { readerPoolSize: 1 },
  ),
);

it.effect("queues reader admissions in FIFO order", () =>
  withReaderClient(
    (sql) =>
      Effect.gen(function* () {
        yield* countEntries(sql).pipe(SqliteClient.readOnly);
        const worker = startedWorkers.at(-1)!;
        const send = worker.postMessage.bind(worker);
        const requests: Array<() => void> = [];
        using held = vi.spyOn(worker, "postMessage").mockImplementation((...args) => {
          requests.push(() => send(...args));
        });
        const reads = [];
        for (let i = 0; i < 64; i++)
          reads.push(
            yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
              startImmediately: true,
            }),
          );
        const a = yield* Effect.forkChild(
          countEntries(sql).pipe(SqliteClient.readOnly, Effect.result),
          { startImmediately: true },
        );
        const b = yield* Effect.forkChild(
          countEntries(sql).pipe(SqliteClient.readOnly, Effect.result),
          { startImmediately: true },
        );
        assert.isUndefined(a.pollUnsafe());
        assert.isUndefined(b.pollUnsafe());
        held.mockRestore();
        for (const request of requests) request();
        for (const read of reads) yield* Fiber.join(read);
        assert.equal((yield* Fiber.join(a))._tag, "Success");
        assert.equal((yield* Fiber.join(b))._tag, "Success");
      }),
    { readerPoolSize: 1 },
  ),
);
