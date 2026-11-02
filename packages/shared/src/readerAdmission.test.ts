import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
  BACKGROUND_READER_ADMISSION_TIMEOUT,
  backgroundReads,
  failFastReaderAdmission,
  makeReaderAdmission,
  READER_LANE_AGING_MS,
  ReaderAdmissionClosedError,
  readerAdmissionTimeout,
  type ReaderAdmissionToken,
} from "./readerAdmission.ts";
import { isReaderAdmissionOverload } from "./readerAdmissionOverload.ts";

const make = (
  timeout: Duration.Duration | null = Duration.seconds(30),
  lanes: Partial<{
    limit: number;
    backgroundLimit: number;
    backgroundTimeout: Duration.Duration | null;
  }> = {},
) =>
  makeReaderAdmission({
    limit: 1,
    backgroundLimit: 1,
    timeout,
    backgroundTimeout: timeout,
    honorFailFast: true,
    agingMs: READER_LANE_AGING_MS,
    ...lanes,
  });

const pausedScheduler = () => {
  const control = { paused: false, tasks: [] as Array<() => void> };
  const scheduler: Scheduler.Scheduler = {
    executionMode: "async",
    shouldYield: () => control.paused,
    makeDispatcher: () => ({
      scheduleTask: (task) => {
        control.tasks.push(task);
      },
      flush: () => {},
    }),
  };
  const resume = () => {
    control.paused = false;
    for (const task of control.tasks.splice(0)) task();
  };
  return { control, scheduler, resume };
};

it.effect("grants queued readers FIFO", () =>
  Effect.gen(function* () {
    const gate = yield* make();
    const held = yield* gate.acquire();
    const a = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
    const b = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
    assert.isUndefined(a.pollUnsafe());
    assert.isUndefined(b.pollUnsafe());
    yield* gate.release(held);
    const first = yield* Fiber.join(a);
    assert.isUndefined(b.pollUnsafe());
    yield* gate.release(first);
    yield* gate.release(yield* Fiber.join(b));
  }),
);

it.effect("expires exactly at its deadline", () =>
  Effect.gen(function* () {
    const gate = yield* make(Duration.seconds(1));
    const held = yield* gate.acquire();
    const waiter = yield* Effect.forkChild(Effect.result(gate.acquire()), {
      startImmediately: true,
    });
    yield* TestClock.adjust("999 millis");
    assert.isUndefined(waiter.pollUnsafe());
    yield* TestClock.adjust("1 millis");
    const result = yield* Fiber.join(waiter);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.isTrue(isReaderAdmissionOverload(result.failure));
    yield* gate.release(held);
  }),
);

it.effect("zero timeout admits free capacity and rejects saturation", () =>
  Effect.gen(function* () {
    const gate = yield* make(Duration.zero);
    const held = yield* gate.acquire();
    const error = yield* Effect.flip(gate.acquire());
    assert.isTrue(isReaderAdmissionOverload(error));
    yield* gate.release(held);
    yield* gate.release(yield* gate.acquire());
  }),
);

it.effect("cancelling a waiter leaves the next reader eligible", () =>
  Effect.gen(function* () {
    const gate = yield* make();
    const held = yield* gate.acquire();
    const a = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
    const b = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
    yield* Fiber.interrupt(a);
    yield* gate.release(held);
    yield* gate.release(yield* Fiber.join(b));
  }),
);

it.effect("fail fast does not enter the queue", () =>
  Effect.gen(function* () {
    const gate = yield* make();
    const held = yield* gate.acquire();
    const error = yield* failFastReaderAdmission(gate.acquire()).pipe(Effect.flip);
    assert.isTrue(isReaderAdmissionOverload(error));
    yield* gate.release(held);
    yield* gate.release(yield* gate.acquire());
  }),
);

it.effect("deadline expires an uninterruptible waiter", () =>
  Effect.gen(function* () {
    const gate = yield* make(Duration.seconds(1));
    const held = yield* gate.acquire();
    const waiter = yield* Effect.forkChild(
      gate.acquire().pipe(Effect.uninterruptible, Effect.result),
      { startImmediately: true },
    );
    assert.isUndefined(waiter.pollUnsafe());
    yield* TestClock.adjust("1 seconds");
    const result = yield* Fiber.join(waiter);
    assert.equal(result._tag, "Failure");
    yield* gate.release(held);
  }),
);

it.effect("closing the gate fails queued and uninterruptible waiters as closed", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const gate = yield* Scope.provide(make(), scope);
    const held = yield* gate.acquire();
    const a = yield* Effect.forkChild(gate.acquire().pipe(Effect.result), {
      startImmediately: true,
    });
    const b = yield* Effect.forkChild(
      backgroundReads(gate.acquire()).pipe(Effect.uninterruptible, Effect.result),
      { startImmediately: true },
    );
    yield* Scope.close(scope, Exit.void);
    for (const fiber of [a, b]) {
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ReaderAdmissionClosedError);
        assert.isFalse(isReaderAdmissionOverload(result.failure));
      }
    }
    yield* gate.release(held);
  }),
);

it.effect("skips an expired waiter at handoff even before its timer runs", () =>
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
    const held = yield* gate.acquire();
    const first = yield* Effect.forkChild(
      gate.acquire().pipe(Effect.provideService(Clock.Clock, clock), Effect.result),
      { startImmediately: true },
    );
    now = 500_000_000n;
    const second = yield* Effect.forkChild(
      gate.acquire().pipe(Effect.provideService(Clock.Clock, clock)),
      { startImmediately: true },
    );
    now = 1_000_000_000n;
    yield* gate.release(held);
    const expired = yield* Fiber.join(first);
    assert.equal(expired._tag, "Failure");
    if (expired._tag === "Failure") assert.isTrue(isReaderAdmissionOverload(expired.failure));
    yield* gate.release(yield* Fiber.join(second));
  }),
);

it.effect("interrupting a granted waiter passes its token to the next waiter", () =>
  Effect.gen(function* () {
    const paused = pausedScheduler();
    const gate = yield* make();
    const held = yield* gate.acquire();
    const first = yield* Effect.forkChild(
      gate.acquire().pipe(Effect.provideService(Scheduler.Scheduler, paused.scheduler)),
      { startImmediately: true },
    );
    const second = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
    paused.control.paused = true;
    yield* gate.release(held);
    assert.isUndefined(first.pollUnsafe());
    first.interruptUnsafe();
    paused.resume();
    yield* Fiber.await(first);
    yield* gate.release(yield* Fiber.join(second));
  }),
);

it.effect("a grant before the deadline remains owned when the reader resumes after it", () =>
  Effect.gen(function* () {
    const paused = pausedScheduler();
    const gate = yield* make(Duration.seconds(1));
    const held = yield* gate.acquire();
    const waiter = yield* Effect.forkChild(
      gate.acquire().pipe(Effect.provideService(Scheduler.Scheduler, paused.scheduler)),
      { startImmediately: true },
    );
    yield* TestClock.adjust("999 millis");
    paused.control.paused = true;
    yield* gate.release(held);
    assert.isUndefined(waiter.pollUnsafe());
    yield* TestClock.adjust("2 millis");
    assert.isUndefined(waiter.pollUnsafe());
    paused.resume();
    yield* gate.release(yield* Fiber.join(waiter));
    yield* gate.release(yield* gate.acquire());
  }),
);

it.effect("settled timers cannot expire a later owner", () =>
  Effect.gen(function* () {
    const gate = yield* make(Duration.seconds(1));
    const held = yield* gate.acquire();
    const cancelled = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
    yield* Fiber.interrupt(cancelled);
    const granted = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
    yield* gate.release(held);
    const owner = yield* Fiber.join(granted);
    yield* TestClock.adjust("1 seconds");
    const next = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
    assert.isUndefined(next.pollUnsafe());
    yield* gate.release(owner);
    yield* gate.release(yield* Fiber.join(next));
  }),
);

it.effect("interrupts a timer when the waiter is granted before its handle is stored", () =>
  Effect.gen(function* () {
    const gate = yield* make(Duration.seconds(1));
    const stopped = yield* Deferred.make<void>();
    let held: ReaderAdmissionToken | undefined;
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => 0,
      currentTimeMillis: Effect.succeed(0),
      currentTimeNanosUnsafe: () => 0n,
      currentTimeNanos: Effect.succeed(0n),
      monotonicTimeNanosUnsafe: () => 0n,
      monotonicTimeNanos: Effect.succeed(0n),
      sleep: () =>
        Effect.suspend(() => (held === undefined ? Effect.void : gate.release(held))).pipe(
          Effect.andThen(Effect.never),
          Effect.onExit(() => Deferred.succeed(stopped, undefined)),
        ),
    };
    held = yield* gate.acquire();
    const second = yield* gate.acquire().pipe(Effect.provideService(Clock.Clock, clock));
    yield* Deferred.await(stopped);
    yield* gate.release(second);
    yield* gate.release(yield* gate.acquire());
  }),
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

it.effect(
  "background reads leave the last admission to an interactive read, even past a queued background read",
  () =>
    Effect.gen(function* () {
      const gate = yield* make(Duration.seconds(30), { limit: 4, backgroundLimit: 3 });
      const background = [];
      for (let index = 0; index < 3; index++)
        background.push(yield* backgroundReads(gate.acquire()));
      const queued = yield* Effect.forkChild(backgroundReads(gate.acquire()), {
        startImmediately: true,
      });
      assert.isUndefined(queued.pollUnsafe(), "a fourth background read must wait");
      const interactive = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
      assert.isDefined(
        interactive.pollUnsafe(),
        "the interactive read takes the reserved admission",
      );
      assert.isUndefined(queued.pollUnsafe());
      const [first, ...rest] = background;
      if (first === undefined) return assert.fail("three background admissions were held");
      yield* gate.release(first);
      for (const token of [...rest, yield* Fiber.join(queued), yield* Fiber.join(interactive)])
        yield* gate.release(token);
    }),
);

it.effect("an interactive waiter goes first until a background waiter has aged", () =>
  Effect.gen(function* () {
    const gate = yield* make();
    const held = yield* gate.acquire();
    const background = yield* Effect.forkChild(backgroundReads(gate.acquire()), {
      startImmediately: true,
    });
    const first = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
    yield* gate.release(held);
    assert.isDefined(first.pollUnsafe(), "a young background waiter yields to an interactive one");
    assert.isUndefined(background.pollUnsafe());
    const second = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
    yield* TestClock.adjust(READER_LANE_AGING_MS);
    yield* gate.release(yield* Fiber.join(first));
    assert.isDefined(background.pollUnsafe(), "the aged background waiter goes first");
    assert.isUndefined(second.pollUnsafe());
    yield* gate.release(yield* Fiber.join(background));
    yield* gate.release(yield* Fiber.join(second));
  }),
);

it.effect("an aged background waiter still respects the background limit", () =>
  Effect.gen(function* () {
    const gate = yield* make(Duration.seconds(30), { limit: 2, backgroundLimit: 1 });
    const backgroundHeld = yield* backgroundReads(gate.acquire());
    const interactiveHeld = yield* gate.acquire();
    const background = yield* Effect.forkChild(backgroundReads(gate.acquire()), {
      startImmediately: true,
    });
    yield* TestClock.adjust(READER_LANE_AGING_MS);
    const interactive = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
    yield* gate.release(interactiveHeld);
    assert.isDefined(interactive.pollUnsafe());
    assert.isUndefined(background.pollUnsafe(), "aging must not exceed the background limit");
    yield* gate.release(backgroundHeld);
    yield* gate.release(yield* Fiber.join(background));
    yield* gate.release(yield* Fiber.join(interactive));
  }),
);

it.effect("a background waiter fails at its shorter deadline while an interactive one waits", () =>
  Effect.gen(function* () {
    const gate = yield* make(Duration.seconds(30), {
      backgroundTimeout: BACKGROUND_READER_ADMISSION_TIMEOUT,
    });
    const held = yield* gate.acquire();
    const background = yield* Effect.forkChild(backgroundReads(gate.acquire()).pipe(Effect.flip), {
      startImmediately: true,
    });
    const interactive = yield* Effect.forkChild(gate.acquire(), { startImmediately: true });
    yield* TestClock.adjust(BACKGROUND_READER_ADMISSION_TIMEOUT);
    assert.isTrue(isReaderAdmissionOverload(yield* Fiber.join(background)));
    assert.isUndefined(interactive.pollUnsafe());
    yield* gate.release(held);
    yield* gate.release(yield* Fiber.join(interactive));
  }),
);

it.effect.each(["interactive", "background"] as const)(
  "a %s read interrupted after its grant returns its admission",
  (lane) =>
    Effect.gen(function* () {
      const paused = pausedScheduler();
      const gate = yield* make(Duration.seconds(30), { limit: 2, backgroundLimit: 1 });
      const first = yield* gate.acquire();
      const second = yield* gate.acquire();
      const read = lane === "background" ? backgroundReads(gate.acquire()) : gate.acquire();
      const waiter = yield* Effect.forkChild(
        read.pipe(Effect.provideService(Scheduler.Scheduler, paused.scheduler)),
        { startImmediately: true },
      );
      paused.control.paused = true;
      yield* gate.release(first);
      assert.isUndefined(waiter.pollUnsafe());
      waiter.interruptUnsafe();
      paused.resume();
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(waiter)));
      yield* gate.release(second);
      // A leaked admission makes one of these two immediate refills fail.
      const refill = [
        yield* failFastReaderAdmission(backgroundReads(gate.acquire())),
        yield* failFastReaderAdmission(gate.acquire()),
      ];
      const overflow = yield* failFastReaderAdmission(gate.acquire()).pipe(Effect.flip);
      assert.isTrue(isReaderAdmissionOverload(overflow));
      for (const token of refill) yield* gate.release(token);
    }),
);

it.effect("a fiber forked under backgroundReads waits in the background lane", () =>
  Effect.gen(function* () {
    const gate = yield* make(Duration.seconds(30), { limit: 2, backgroundLimit: 1 });
    const [first, second] = yield* backgroundReads(
      Effect.all([
        Effect.forkChild(gate.acquire(), { startImmediately: true }),
        Effect.forkChild(gate.acquire(), { startImmediately: true }),
      ]),
    );
    assert.isDefined(first.pollUnsafe());
    assert.isUndefined(
      second.pollUnsafe(),
      "the second forked read is held by the background limit",
    );
    yield* gate.release(yield* Fiber.join(first));
    yield* gate.release(yield* Fiber.join(second));
  }),
);

it.effect("fail fast refuses each lane once that lane cannot be admitted", () =>
  Effect.gen(function* () {
    const gate = yield* make(Duration.seconds(30), { limit: 2, backgroundLimit: 1 });
    const background = yield* failFastReaderAdmission(backgroundReads(gate.acquire()));
    const refused = yield* failFastReaderAdmission(backgroundReads(gate.acquire())).pipe(
      Effect.flip,
    );
    assert.isTrue(isReaderAdmissionOverload(refused));
    const interactive = yield* failFastReaderAdmission(gate.acquire());
    assert.isTrue(
      isReaderAdmissionOverload(yield* failFastReaderAdmission(gate.acquire()).pipe(Effect.flip)),
    );
    yield* gate.release(background);
    yield* gate.release(interactive);
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
              countEntries(sql).pipe(
                SqliteClient.readOnly,
                SqliteClient.failFastReaderAdmission,
                Effect.result,
              ),
              { startImmediately: true },
            );
            assert.isUndefined(read.pollUnsafe());
            refill.push(read);
          }
          const overflow = yield* countEntries(sql).pipe(
            SqliteClient.readOnly,
            SqliteClient.failFastReaderAdmission,
            Effect.flip,
          );
          assert.isTrue(SqliteClient.isReaderAdmissionOverload(overflow));
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
        const last = reads.pop();
        assert.isDefined(last);
        if (last === undefined) return;
        yield* Fiber.interrupt(last);
        yield* TestClock.adjust("30 seconds");
        assert.isDefined(b.pollUnsafe(), "B must expire while A owns the released admission");
        const result = yield* Fiber.join(b);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.isTrue(SqliteClient.isReaderAdmissionOverload(result.failure));
        assert.isUndefined(a.pollUnsafe());
        held.mockRestore();
        for (const request of requests) request();
        assert.equal((yield* Fiber.join(a))._tag, "Success");
        for (const read of reads) yield* Fiber.join(read);
      }),
    { readerPoolSize: 1 },
  ),
);

const holdSlot = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(
      sql
        .withTransaction(
          countEntries(sql).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(SqliteClient.readOnly),
      { startImmediately: true },
    );
    yield* Deferred.await(entered);
    return {
      fiber,
      release: Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(fiber))),
    };
  });

it.effect(
  "statement and transaction reads interrupted while waiting for a reader slot free every slot",
  () =>
    withReaderClient(
      (sql) =>
        Effect.gen(function* () {
          const holders = [yield* holdSlot(sql), yield* holdSlot(sql)];
          const statement = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
            startImmediately: true,
          });
          const transaction = yield* Effect.forkChild(
            sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
            { startImmediately: true },
          );
          yield* Fiber.interrupt(statement);
          yield* Fiber.interrupt(transaction);
          for (const holder of holders) yield* holder.release;
          const again = [yield* holdSlot(sql), yield* holdSlot(sql)];
          for (const holder of again) yield* holder.release;
        }),
      { readerPoolSize: 2 },
    ),
);

it.effect("a transaction read interrupted after its slot grant returns the slot", () =>
  withReaderClient(
    (sql) =>
      Effect.gen(function* () {
        const holder = yield* holdSlot(sql);
        const paused = pausedScheduler();
        const waiter = yield* Effect.forkChild(
          sql
            .withTransaction(countEntries(sql))
            .pipe(
              SqliteClient.readOnly,
              Effect.provideService(Scheduler.Scheduler, paused.scheduler),
            ),
          { startImmediately: true },
        );
        paused.control.paused = true;
        yield* holder.release;
        assert.isUndefined(waiter.pollUnsafe());
        waiter.interruptUnsafe();
        paused.resume();
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(waiter)));
        const again = yield* holdSlot(sql);
        yield* again.release;
      }),
    { readerPoolSize: 1 },
  ),
);

it.effect("a fail-fast read waits for a reader slot while admission is free", () =>
  withReaderClient(
    (sql) =>
      Effect.gen(function* () {
        const holder = yield* holdSlot(sql);
        const read = yield* Effect.forkChild(
          countEntries(sql).pipe(SqliteClient.readOnly, SqliteClient.failFastReaderAdmission),
          { startImmediately: true },
        );
        assert.isUndefined(read.pollUnsafe(), "a busy pool slot is not admission overload");
        yield* holder.release;
        assert.equal(yield* Fiber.join(read), 1);
      }),
    { readerPoolSize: 1 },
  ),
);

it.effect("closing the client fails reads waiting for a reader slot as closed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-admission-" });
    const scope = yield* Scope.make();
    const services = yield* Layer.buildWithScope(
      SqliteClient.layer({
        filename: path.join(directory, "state.sqlite"),
        readerWorker: true,
        readerPoolSize: 1,
      }),
      scope,
    );
    const sql = Context.get(services, SqlClient.SqlClient);
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
    const holder = yield* holdSlot(sql);
    const waiting = [
      yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly, Effect.flip), {
        startImmediately: true,
      }),
      yield* Effect.forkChild(
        sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly, Effect.flip),
        { startImmediately: true },
      ),
    ];
    yield* Scope.close(scope, Exit.void);
    for (const fiber of waiting) {
      const error = yield* Fiber.join(fiber);
      assert.equal(error.message, "Database client closed");
      assert.isFalse(SqliteClient.isReaderAdmissionOverload(error));
    }
    yield* Fiber.interrupt(holder.fiber);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
