import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Borrower, Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import { satisfiesSemverRange } from "./semver.ts";

import { readerWorkerSource, checkpointWorkerSource } from "./sqliteWorkerSources.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  /** Ignored for in-memory databases, which cannot share a second connection. */
  readonly readerWorker?: boolean | undefined;
  readonly readerStartupTimeout?: Duration.Input | undefined;
  /** Ignored for in-memory databases. */
  readonly checkpointWorker?: boolean | undefined;
}

// SqlClient masks transaction acquisition, so readOnly carries the caller's interruption policy.
const ReadOnly = Context.Reference<typeof Effect.interruptible | undefined>(
  "@goat/shared/nodeSqliteClient/ReadOnly",
  { defaultValue: () => undefined },
);

/** Wrap the whole transaction; existing write transactions retain the writer, and writes on the reader fail as readonly. */
export const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    restore(Effect.provideService(effect, ReadOnly, restore)),
  );

interface Acquired {
  readonly connection: "writer" | "reader";
  readonly lockWaitMs: number;
}

interface ConnectionOwner {
  readonly fiberId: number;
  readonly name: string;
  readonly traceId?: string;
  readonly spanId?: string;
}

const connectionOwner = (fiber: Fiber.Fiber<unknown, unknown>): ConnectionOwner => {
  const current = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (current?._tag !== "Span") return { fiberId: fiber.id, name: "untraced" };
  let span: Tracer.Span = current;
  while (span.name === "sqlite" || span.name === "sql.transaction") {
    const parent: Tracer.AnySpan | undefined = Option.getOrUndefined(span.parent);
    if (parent?._tag !== "Span") break;
    span = parent;
  }
  return { fiberId: fiber.id, name: span.name, traceId: span.traceId, spanId: span.spanId };
};

const annotateAcquired = (
  fiber: Fiber.Fiber<unknown, unknown>,
  acquired: Acquired | undefined,
  ownerAtWaitStart?: ConnectionOwner,
) => {
  const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (span?._tag !== "Span" || acquired === undefined) return;
  span.attribute("db.connection", acquired.connection);
  span.attribute("db.lock_wait_ms", acquired.lockWaitMs);
  if (ownerAtWaitStart !== undefined) {
    span.attribute("db.lock_owner_at_start.fiber_id", ownerAtWaitStart.fiberId);
    span.attribute("db.lock_owner_at_start.name", ownerAtWaitStart.name);
    if (ownerAtWaitStart.traceId !== undefined) {
      span.attribute("db.lock_owner_at_start.trace_id", ownerAtWaitStart.traceId);
    }
    if (ownerAtWaitStart.spanId !== undefined) {
      span.attribute("db.lock_owner_at_start.span_id", ownerAtWaitStart.spanId);
    }
  }
};

const TransactionAcquire = Context.Reference<
  | {
      acquired?: Acquired;
      ownerAtWaitStart: ConnectionOwner | undefined;
      restore: typeof Effect.interruptible | undefined;
    }
  | undefined
>("@goat/shared/nodeSqliteClient/TransactionAcquire", { defaultValue: () => undefined });

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} cannot run this node:sqlite client. Upgrade to Node.js ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

// `node:sqlite` before 24.16.0 and 26.1.0 cuts TEXT off at a NUL (nodejs/node#61954).
// The server's `engines.node` is this same range.
export const NODE_SQLITE_RUNTIME_RANGE = "^24.16.0 || >=26.1.0";

const checkNodeSqliteCompat = Effect.fn("checkNodeSqliteCompat")(function () {
  if (!satisfiesSemverRange(process.versions.node, NODE_SQLITE_RUNTIME_RANGE)) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: NODE_SQLITE_RUNTIME_RANGE,
      }),
    );
  }
  return Effect.void;
});

// node:sqlite supplies errcode; classifySqliteError expects errno.
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

// WAL recovery may return SQLITE_BUSY_RECOVERY without invoking SQLite's
// busy handler, even with busy_timeout set. It fails before the statement can
// change data, so retry only this code, never BUSY_SNAPSHOT or a whole transaction.
// Yield between attempts so recovery on another connection can finish without
// blocking the main thread. Cap the wait at 500 delays of 10 ms.
const isWalRecovery = (error: SqlError) => {
  const cause = error.reason.cause;
  return Predicate.hasProperty(cause, "errcode") && cause.errcode === 261;
};

const waitForWalRecovery = <A, R>(effect: Effect.Effect<A, SqlError, R>) =>
  Effect.catchIf(effect, isWalRecovery, () =>
    // Keep retry machinery off the successful first attempt. The first failure
    // already consumed one attempt, leaving 500 delayed attempts in total.
    Effect.delay(
      Effect.retry(effect, {
        times: 499,
        schedule: Schedule.spaced("10 millis"),
        while: isWalRecovery,
      }),
      "10 millis",
    ),
  );

// SQLite retains text/blob bindings until rebind or finalization; node:sqlite cannot clear them.
const LARGE_BINDING_SIZE = 64 * 1024;

const isBlob = (value: unknown): value is ArrayBufferView | ArrayBufferLike =>
  ArrayBuffer.isView(value) || NodeUtil.types.isAnyArrayBuffer(value);

// Node 24.20's `node:sqlite` (SQLite 3.53.4) binds a raw ArrayBuffer parameter as
// NULL. A Uint8Array of the same bytes binds on that build and on later ones.
const sqliteBlob = (value: ArrayBufferLike): Uint8Array | ArrayBufferLike => {
  try {
    return new Uint8Array(value);
  } catch {
    return value;
  }
};

const sqliteParameter = (value: unknown): unknown => {
  if (NodeUtil.types.isAnyArrayBuffer(value)) return sqliteBlob(value);
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let changed = false;
  for (const descriptor of Object.values(descriptors)) {
    if (
      descriptor.enumerable &&
      "value" in descriptor &&
      NodeUtil.types.isAnyArrayBuffer(descriptor.value)
    ) {
      changed = true;
      break;
    }
  }
  if (!changed) return value;
  const copy = typeof value === "function" ? function namedBinding() {} : {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if ("value" in descriptor && NodeUtil.types.isAnyArrayBuffer(descriptor.value)) {
      Object.defineProperty(copy, key, { ...descriptor, value: sqliteBlob(descriptor.value) });
    } else {
      Object.defineProperty(copy, key, descriptor);
    }
  }
  return copy;
};

const sqliteParameters = (params: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
  let changed = false;
  const next = params.map((param) => {
    const normalized = sqliteParameter(param);
    if (normalized !== param) changed = true;
    return normalized;
  });
  return changed ? next : params;
};

const bindingSize = (value: unknown): number => {
  if (typeof value === "string") {
    return value.length;
  }
  return isBlob(value) ? value.byteLength : 0;
};

const hasLargeBinding = (params: ReadonlyArray<unknown>): boolean => {
  try {
    let size = 0;
    for (const param of params) {
      if (
        (typeof param === "object" || typeof param === "function") &&
        param !== null &&
        !isBlob(param)
      ) {
        // Named parameters may be callable objects; read data properties only to avoid invoking getters twice.
        for (const property of Object.values(Object.getOwnPropertyDescriptors(param))) {
          if (!property.enumerable) continue;
          if (!("value" in property)) return true;
          size += bindingSize(property.value);
        }
      } else {
        size += bindingSize(param);
      }
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    return true;
  }
};

interface ReaderRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly cached: boolean;
  readonly values: boolean;
  readonly raw: boolean;
}

type ReaderStartup =
  | { readonly type: "ready" }
  | { readonly type: "unavailable"; readonly message: string; readonly errcode?: unknown };

type ReaderReply =
  | { readonly id: number; readonly rows: ReadonlyArray<any> }
  | {
      readonly id: number;
      readonly error: {
        readonly operation: "open" | "prepare" | "execute";
        readonly message: string;
        readonly code?: unknown;
        readonly errcode?: unknown;
        readonly errstr?: unknown;
      };
    };

const readerFailureMessages = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const failed = (cause: unknown, message: string, operation: string) =>
  new SqlError({ reason: classifyError(cause, message, operation) });

// Keep startup retries on the caller's Effect clock, just like statements.
// The worker closes a partially opened connection before reporting a failure.
const initializeWorker = (worker: NodeWorkerThreads.Worker) =>
  Effect.callback<void, SqlError>((resume) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onError = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(failed(cause, "Failed to open database", "open")));
    };
    const onExit = (code: number) => onError(new Error(`worker exited with code ${code}`));
    const onMessage = (reply: ReaderStartup | ReaderReply) => {
      if (!("type" in reply)) return;
      cleanup();
      resume(
        reply.type === "ready"
          ? Effect.void
          : Effect.fail(
              failed(
                Object.assign(new Error(reply.message), { errcode: reply.errcode }),
                "Failed to open database",
                "open",
              ),
            ),
      );
    };
    if (worker.threadId === -1) {
      onExit(-1);
      return;
    }
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
    worker.postMessage({ type: "initialize" });
    return Effect.sync(cleanup);
  }).pipe(waitForWalRecovery);

// Read-transaction cleanup succeeds after worker exit because it can no longer change anything.
const endsReadTransaction = (sql: string) => /^\s*ROLLBACK\b|^\s*COMMIT\b/i.test(sql);

// Bind transactions to one worker; fail after its exit instead of resuming outside the transaction on a replacement.
const makeReader = Effect.fn("SqliteReader.make")(function* (options: SqliteClientConfig) {
  const scope = yield* Effect.scope;
  const starting = yield* Semaphore.make(1);
  let current:
    | {
        readonly worker: NodeWorkerThreads.Worker;
        readonly connection: Connection;
        readonly started: Effect.Effect<ReaderStartup>;
      }
    | undefined;
  const clock = yield* Clock.Clock;
  let retryAt = 0n;
  let retryMs = 250;
  let retiring = Promise.resolve();
  const backoff = () => {
    retryAt = clock.monotonicTimeNanosUnsafe() + BigInt(retryMs) * 1_000_000n;
    retryMs = Math.min(8_000, retryMs * 2);
  };
  let nextRequestId = 0;

  const start = Effect.fn("SqliteReader.start")(function* () {
    const worker = yield* Effect.try({
      try: () =>
        new NodeWorkerThreads.Worker(readerWorkerSource, {
          eval: true,
          workerData: {
            filename: options.filename,
            allowExtension: options.allowExtension ?? false,
            prepareCacheSize: options.prepareCacheSize ?? 200,
          },
        }),
      catch: (cause) => failed(cause, "Failed to open database", "open"),
    });
    const requests = yield* Semaphore.make(1);
    let stoppedMessage: string | undefined;
    const pending = new Map<
      number,
      { readonly endsTransaction: boolean; resume: (reply: ReaderReply) => void }
    >();
    const stop = (message: string) => {
      stoppedMessage = message;
      if (current?.worker === worker) {
        current = undefined;
        backoff();
        retiring = worker.terminate().then(() => undefined);
      }
      for (const [id, request] of pending) {
        request.resume(
          request.endsTransaction
            ? { id, rows: [] }
            : { id, error: { operation: "execute", message } },
        );
      }
      pending.clear();
    };
    worker.on("message", (reply: ReaderReply | ReaderStartup) => {
      if (stoppedMessage !== undefined) return;
      if ("type" in reply) {
        if (pending.size === 0) worker.unref();
        return;
      }
      const request = pending.get(reply.id);
      if (request === undefined) return;
      pending.delete(reply.id);
      if (pending.size === 0) worker.unref();
      if ("rows" in reply) retryMs = 250;
      request.resume(reply);
    });
    worker.on("error", (cause) => stop(`Database reader failed: ${cause.message}`));
    worker.on("exit", (code) => stop(`Database reader exited with code ${code}`));

    const request = (input: ReaderRequest) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const endsTransaction = endsReadTransaction(input.sql);
        if (stoppedMessage !== undefined) {
          return endsTransaction
            ? Effect.as(
                Effect.promise(() => retiring),
                [],
              )
            : Effect.fail(
                failed(new Error(stoppedMessage), readerFailureMessages.execute, "execute"),
              );
        }
        const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
        return Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
          const id = nextRequestId++;
          pending.set(id, {
            endsTransaction,
            resume: (reply) => {
              if ("rows" in reply) {
                resume(Effect.succeed(reply.rows));
                return;
              }
              const { operation, message, ...codes } = reply.error;
              resume(
                Effect.fail(
                  failed(
                    Object.assign(new Error(message), codes),
                    readerFailureMessages[operation],
                    operation,
                  ),
                ),
              );
            },
          });
          if (pending.size === 1) worker.ref();
          const params = sqliteParameters(input.params);
          const cached = input.cached && !hasLargeBinding(params);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage({ id, safeIntegers, ...input, params, cached });
          return Effect.suspend(() => {
            const pendingRequest = pending.get(id);
            if (pendingRequest === undefined) return Effect.void;
            // Native SQL stops only when this worker exits; do not reuse its connection.
            pendingRequest.resume = () => {};
            stoppedMessage = "Database reader retired after request cancellation";
            if (current?.worker === worker) current = undefined;
            retiring = worker.terminate().then(() => undefined);
            return Effect.promise(() => retiring);
          });
        });
      }).pipe(waitForWalRecovery, requests.withPermits(1));

    const connection = identity<Connection>({
      execute(sql, params, rowTransform) {
        const effect = request({ sql, params, cached: true, values: false, raw: false });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeRaw(sql, params) {
        return request({ sql, params, cached: true, values: false, raw: true });
      },
      executeValues(sql, params) {
        return request({ sql, params, cached: true, values: true, raw: false });
      },
      executeValuesUnprepared(sql, params) {
        return request({ sql, params: params ?? [], cached: false, values: true, raw: false });
      },
      executeUnprepared(sql, params, rowTransform) {
        // Read snapshots need deferred BEGIN; readonly connections reject IMMEDIATE and EXCLUSIVE.
        const statement = /^\s*BEGIN\b/i.test(sql) ? "BEGIN" : sql;
        const effect = request({
          sql: statement,
          params: params ?? [],
          cached: false,
          values: false,
          raw: false,
        });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
    const startup = yield* initializeWorker(worker).pipe(
      Effect.match({
        onSuccess: (): ReaderStartup => ({ type: "ready" }),
        onFailure: (error): ReaderStartup => ({
          type: "unavailable",
          message: String(error.reason.cause),
        }),
      }),
      Effect.forkIn(scope),
    );
    current = { worker, connection, started: Fiber.join(startup) };
    return current;
  });

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await current?.worker.terminate();
      await retiring;
    }),
  );

  const startupTimeout = Duration.fromInputUnsafe(
    options.readerStartupTimeout ?? Duration.seconds(10),
  );

  const retire = Effect.fn("SqliteReader.retire")(function* (
    reader: typeof current,
    cause: unknown,
  ) {
    if (reader !== undefined && current === reader) {
      current = undefined;
      backoff();
      retiring = reader.worker.terminate().then(() => undefined);
    }
    yield* Effect.promise(() => retiring);
    return yield* failed(cause, "Database reader unavailable", "open");
  });

  return Effect.withFiber((fiber) => {
    const restore = Context.get(fiber.context, ReadOnly) ?? identity;
    return restore(
      starting.withPermits(1)(
        Effect.gen(function* () {
          if (current === undefined) yield* Effect.promise(() => retiring);
          const remaining = Number(retryAt - clock.monotonicTimeNanosUnsafe()) / 1e6;
          if (remaining > 0) yield* Effect.sleep(Duration.millis(remaining));
          const reader =
            current ??
            (yield* start().pipe(
              Effect.catch((cause) => {
                backoff();
                return retire(undefined, cause);
              }),
            ));
          const startup = yield* Effect.timeoutOption(reader.started, startupTimeout);
          if (current !== reader)
            return yield* retire(undefined, new Error("Reader epoch retired"));
          if (Option.isSome(startup) && startup.value.type === "ready") return reader.connection;
          return yield* retire(
            reader,
            new Error(
              Option.isSome(startup) && startup.value.type === "unavailable"
                ? startup.value.message
                : "Reader startup deadline exceeded",
            ),
          );
        }),
      ),
    );
  });
});

const CHECKPOINT_FRAMES = 1000;
const CHECKPOINT_IDLE_MS = 100;
const CHECKPOINT_BACKPRESSURE_FRAMES = 10 * CHECKPOINT_FRAMES;

const readSafeSqliteInteger = (value: unknown) => {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : undefined;
};

const startCheckpointWorker = Effect.fn("SqliteCheckpoint.start")(function* (
  filename: string,
  writer: NodeSqlite.DatabaseSync,
) {
  const warn = (reason: string) =>
    Effect.logWarning("SQLite checkpoint worker unavailable; recovery pending", { reason });
  if (typeof writer.isTransaction !== "boolean" || typeof writer.setAuthorizer !== "function") {
    return yield* failed(
      new Error("Node SQLite lacks checkpoint capabilities"),
      "Checkpoint worker unsupported",
      "open",
    );
  }
  const version = String(writer.prepare("SELECT sqlite_version() AS version").get()?.version);
  const [major = 0, minor = 0] = version.split(".").map(Number);
  // Older SQLite treats NOOP as PASSIVE, which would checkpoint on the writer.
  if (major < 3 || (major === 3 && minor < 51)) {
    return yield* failed(
      new Error(`SQLite ${version} has no NOOP checkpoint`),
      "Checkpoint worker unsupported",
      "open",
    );
  }
  const journalMode = writer.prepare("PRAGMA journal_mode");
  const frames = writer.prepare("PRAGMA wal_checkpoint(NOOP)");
  const sizeLimit = writer.prepare("PRAGMA journal_size_limit");
  const started = yield* Effect.try({
    try: () =>
      new NodeWorkerThreads.Worker(checkpointWorkerSource, {
        eval: true,
        workerData: {
          filename,
          frames: CHECKPOINT_FRAMES,
          backpressureFrames: CHECKPOINT_BACKPRESSURE_FRAMES,
          idleMs: CHECKPOINT_IDLE_MS,
        },
      }),
    catch: (cause) => failed(cause, "Failed to open checkpoint worker", "open"),
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential("250 millis").pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, Duration.seconds(8))),
        ),
      ),
    }),
  );
  let worker = started;
  let closed = false;
  let retiring = Promise.resolve(0);
  let retryMs = 250;
  let restartFiber: Fiber.Fiber<void, never> | undefined;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let stopped = false;
  let recovering = false;
  let generation = 0;
  let nextId = 0;
  let inFlight: number | undefined;
  let checkAgain = false;
  let ready = false;
  const beginStartup = Deferred.makeUnsafe<void>();
  let blocked = false;
  let log = 0;
  let checkpointed = 0;
  let unknown = false;
  let walEnabled: boolean | undefined;
  let truncate: { id: number; acknowledged: boolean } | undefined;
  type Waiter = { resume: () => void; cancelled: boolean };
  const waiters: Array<Waiter> = [];
  let elected: Waiter | undefined;
  // Only confirmed pre-WAL bootstrap bypasses checkpoint admission.
  const gated = () =>
    walEnabled !== false &&
    !writer.isTransaction &&
    (stopped ||
      recovering ||
      unknown ||
      blocked ||
      truncate !== undefined ||
      log >= CHECKPOINT_BACKPRESSURE_FRAMES);
  const wake = () => {
    if (!gated() && elected === undefined) {
      elected = waiters.shift();
      elected?.resume();
    }
    if (waiters.length === 0 && elected === undefined) worker.unref();
  };
  const release = (waiter: Waiter) => {
    waiter.cancelled = true;
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
    if (elected === waiter) elected = undefined;
    wake();
  };
  const recover = (reason: string) => {
    if (closed || stopped) return;
    stopped = true;
    recovering = true;
    unknown = true;
    truncate = undefined;
    inFlight = undefined;
    retiring = worker.terminate();
    runFork(warn(reason));
    if (restartFiber === undefined) restartFiber = runFork(restart());
  };
  const send = (message: unknown) => {
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      worker.postMessage(message);
    } catch (cause) {
      recover(String(cause));
    }
  };
  const acknowledge = () => {
    if (truncate === undefined || truncate.acknowledged || stopped || writer.isTransaction) return;
    truncate.acknowledged = true;
    send({ type: "truncate", truncateId: truncate.id });
  };
  const observe = () => {
    try {
      if (walEnabled !== true) {
        walEnabled = undefined;
        walEnabled = String(journalMode.get()?.journal_mode).toLowerCase() === "wal";
      }
      const state = frames.get();
      const nextLog = readSafeSqliteInteger(state?.log);
      const nextCheckpointed = readSafeSqliteInteger(state?.checkpointed);
      if (nextLog === undefined || nextCheckpointed === undefined)
        throw new Error("Invalid WAL frame counts");
      log = nextLog;
      checkpointed = nextCheckpointed;
      unknown = false;
    } catch {
      unknown = true;
    }
  };
  const request = (force = false) => {
    if (stopped || writer.isTransaction) return;
    if (!ready) {
      checkAgain = true;
      Deferred.doneUnsafe(beginStartup, Effect.void);
      return;
    }
    if (truncate !== undefined) {
      acknowledge();
      return;
    }
    if (inFlight !== undefined) {
      checkAgain = true;
      return;
    }
    if (!force && !gated() && log - checkpointed < CHECKPOINT_FRAMES) return;
    inFlight = ++nextId;
    try {
      send({
        type: "check",
        id: inFlight,
        generation,
        journalSizeLimit: readSafeSqliteInteger(sizeLimit.get()?.journal_size_limit),
        force: force || gated(),
      });
    } catch (cause) {
      recover(String(cause));
    }
  };
  const check = () => {
    if (writer.isTransaction) return;
    generation++;
    observe();
    request();
    wake();
  };
  const attach = (candidate: NodeWorkerThreads.Worker) => {
    candidate.on("error", (cause) => {
      if (candidate === worker) recover(cause.message);
    });
    candidate.on("exit", (code) => {
      if (candidate === worker) recover(`exited with code ${code}`);
    });
    candidate.on("message", (message: unknown) => {
      if (
        candidate !== worker ||
        stopped ||
        typeof message !== "object" ||
        message === null ||
        !("type" in message)
      )
        return;
      if (
        message.type === "truncate-request" &&
        "truncateId" in message &&
        typeof message.truncateId === "number"
      ) {
        truncate = { id: message.truncateId, acknowledged: false };
        blocked = true;
        acknowledge();
        return;
      }
      if (message.type !== "checkpoint") return;
      const completedTruncate =
        truncate !== undefined && "truncateId" in message && message.truncateId === truncate.id;
      if (completedTruncate) truncate = undefined;
      // An acknowledged truncate excludes new writer mutations, so its result is current.
      if (
        (completedTruncate || ("generation" in message && message.generation === generation)) &&
        "log" in message &&
        typeof message.log === "number" &&
        "checkpointed" in message &&
        typeof message.checkpointed === "number" &&
        "blocked" in message &&
        typeof message.blocked === "boolean"
      ) {
        log = message.log;
        checkpointed = message.checkpointed;
        blocked = message.blocked;
        unknown = false;
        if (ready) {
          walEnabled = true;
          recovering = false;
        }
        retryMs = 250;
      }
      // Even a stale snapshot must retire its request so a newer check can run.
      if ("id" in message && message.id === inFlight) inFlight = undefined;
      if (checkAgain && inFlight === undefined) {
        checkAgain = false;
        request(true);
      }
      wake();
    });
  };
  const restart = Effect.fn("SqliteCheckpoint.recover")(
    function* () {
      while (true) {
        if (closed) return;
        yield* Effect.sleep(Duration.millis(retryMs));
        retryMs = Math.min(8_000, retryMs * 2);
        yield* Effect.promise(() => retiring);
        const replacement = yield* Effect.try(
          () =>
            new NodeWorkerThreads.Worker(checkpointWorkerSource, {
              eval: true,
              workerData: {
                filename,
                frames: CHECKPOINT_FRAMES,
                backpressureFrames: CHECKPOINT_BACKPRESSURE_FRAMES,
                idleMs: CHECKPOINT_IDLE_MS,
              },
            }),
        ).pipe(Effect.result);
        if (Result.isFailure(replacement)) continue;
        worker = replacement.success;
        stopped = false;
        ready = false;
        attach(worker);
        const initialized = yield* initializeWorker(worker).pipe(
          Effect.timeoutOption("10 seconds"),
          Effect.result,
        );
        if (Result.isFailure(initialized) || Option.isNone(initialized.success) || stopped) {
          recover("Checkpoint initialization failed");
          continue;
        }
        ready = true;
        checkAgain = false;
        unknown = true;
        request(true);
        if (stopped) continue;
        if (waiters.length === 0 && elected === undefined) worker.unref();
        return;
      }
    },
    Effect.ensuring(
      Effect.sync(() => {
        restartFiber = undefined;
      }),
    ),
  );
  attach(worker);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      stopped = true;
      if (restartFiber !== undefined) yield* Fiber.interrupt(restartFiber);
      yield* Effect.promise(() => worker.terminate());
      for (const waiter of waiters.splice(0)) waiter.resume();
      elected?.resume();
    }),
  );
  yield* Deferred.await(beginStartup).pipe(
    Effect.andThen(
      initializeWorker(worker).pipe(
        Effect.timeoutOption("10 seconds"),
        Effect.flatMap((ready) =>
          Option.isSome(ready)
            ? Effect.void
            : Effect.fail(
                failed(
                  new Error("Checkpoint startup deadline exceeded"),
                  "Failed to open database",
                  "open",
                ),
              ),
        ),
      ),
    ),
    Effect.matchEffect({
      onSuccess: () =>
        Effect.sync(() => {
          ready = true;
          checkAgain = false;
          request(true);
          wake();
        }),
      onFailure: (error) => Effect.sync(() => recover(String(error.reason.cause))),
    }),
    Effect.forkIn(yield* Effect.scope),
  );
  writer.exec("PRAGMA wal_autocheckpoint = 0;");
  observe();
  worker.unref();

  const runWithAdmission = <A, E>(
    execute: () => Exit.Exit<A, E>,
    admitted?: Waiter,
  ): Effect.Effect<A, E | SqlError> =>
    Effect.suspend(() => {
      if (closed)
        return Effect.fail(
          failed(new Error("Checkpoint scope closed"), "Database connection closed", "execute"),
        );
      if (!gated()) {
        // Release the election after executing; its successor must see the new WAL state.
        try {
          return execute();
        } finally {
          if (admitted !== undefined) release(admitted);
        }
      }
      if (admitted !== undefined) release(admitted);
      const waiter: Waiter = { resume: () => {}, cancelled: false };
      const wait = Effect.uninterruptibleMask((restore) =>
        Effect.withFiber((fiber) =>
          (fiber.getRef(TransactionAcquire)?.restore ?? restore)(
            Effect.callback<void>(function (this: Scheduler.Scheduler, resume) {
              const dispatcher = this.makeDispatcher();
              waiter.resume = () => {
                dispatcher.scheduleTask(() => {
                  if (!waiter.cancelled) resume(Effect.void);
                }, 0);
              };
              waiters.push(waiter);
              worker.ref();
              request(true);
              wake();
              return Effect.sync(() => release(waiter));
            }),
          ),
        ),
      );
      return wait.pipe(
        Effect.flatMap(() => runWithAdmission(execute, waiter)),
        Effect.onInterrupt(() => Effect.sync(() => release(waiter))),
      );
    });
  return { check, runWithAdmission };
});

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const isFileDatabase = options.filename !== ":memory:" && options.filename !== "";
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: () =>
        new NodeSqlite.DatabaseSync(options.filename, {
          readOnly: options.readonly ?? false,
          allowExtension: options.allowExtension ?? false,
        }),
      catch: (cause) =>
        new SqlError({
          reason: classifyError(cause, "Failed to open database", "open"),
        }),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => db.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to close database", "close"),
          }),
      }).pipe(Effect.orDie),
    );
    // Started after the close finalizer, so the worker stops before the writer closes.
    const checkpoint =
      options.checkpointWorker && isFileDatabase
        ? yield* startCheckpointWorker(options.filename, db)
        : undefined;

    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    interface CheckpointClassification {
      backpressure: boolean;
      check: boolean;
    }
    const checkpointClassifications = new WeakMap<
      NodeSqlite.StatementSync,
      CheckpointClassification
    >();
    const mutatingPragmasWithValues = new Set([
      "application_id",
      "auto_vacuum",
      "journal_mode",
      "schema_version",
      "user_version",
    ]);
    const mutatesPragma = (name: string | null, value: string | null) => {
      const pragma = name?.toLowerCase();
      if (pragma === undefined) return false;
      if (pragma === "incremental_vacuum" || pragma === "optimize") return true;
      if (pragma === "wal_checkpoint") return value?.toLowerCase() !== "noop";
      return value !== null && mutatingPragmasWithValues.has(pragma);
    };
    let activeClassification: CheckpointClassification | undefined;
    const withClassification = <A>(
      classification: CheckpointClassification | undefined,
      f: () => A,
    ): A => {
      if (classification === undefined) return f();
      const previous = activeClassification;
      activeClassification = classification;
      try {
        return f();
      } finally {
        activeClassification = previous;
      }
    };
    if (checkpoint !== undefined || (isFileDatabase && options.readerWorker)) {
      if (typeof db.setAuthorizer !== "function") {
        return yield* failed(
          new Error("Node SQLite lacks statement-authorizer support"),
          "SQLite worker mode unsupported",
          "open",
        );
      }
      // SQLite may reprepare an expired statement while it executes. Keep this
      // callback installed and collect only around that statement's prepare/run.
      db.setAuthorizer((actionCode, action, argument) => {
        const constants = NodeSqlite.constants;
        if (
          actionCode === constants.SQLITE_PRAGMA &&
          action?.toLowerCase() === "journal_mode" &&
          argument !== null &&
          argument.toLowerCase() !== "wal"
        )
          return constants.SQLITE_DENY;
        const classification = activeClassification;
        if (checkpoint === undefined || classification === undefined) return constants.SQLITE_OK;
        if (actionCode === constants.SQLITE_TRANSACTION) {
          classification.backpressure ||= action === "BEGIN";
          classification.check ||= action === "COMMIT" || action === "ROLLBACK";
        } else if (actionCode === constants.SQLITE_SAVEPOINT) {
          classification.backpressure ||= action === "BEGIN";
          classification.check = true;
        } else if (actionCode === constants.SQLITE_PRAGMA && mutatesPragma(action, argument)) {
          classification.backpressure = true;
          classification.check = true;
        } else if (
          actionCode !== constants.SQLITE_READ &&
          actionCode !== constants.SQLITE_SELECT &&
          actionCode !== constants.SQLITE_FUNCTION &&
          actionCode !== constants.SQLITE_RECURSIVE &&
          actionCode !== constants.SQLITE_PRAGMA
        ) {
          classification.backpressure = true;
          classification.check = true;
        }
        return constants.SQLITE_OK;
      });
    }
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => {
          const classification = { backpressure: false, check: false };
          const statement = withClassification(classification, () => db.prepare(sql));
          if (checkpoint !== undefined) checkpointClassifications.set(statement, classification);
          return statement;
        },
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare"),
          }),
      }).pipe(waitForWalRecovery);

    const prepareCache = yield* Cache.makeWith(prepare, {
      capacity: options.prepareCacheSize ?? 200,
      // A transient prepare failure must not outlive the lock or missing schema.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? (options.prepareCacheTTL ?? Duration.minutes(10)) : Duration.zero,
    });

    const statementFor = (sql: string, params: ReadonlyArray<unknown>) =>
      hasLargeBinding(params) ? prepare(sql) : Cache.get(prepareCache, sql);

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      mode: "rows" | "raw" | "values" = "rows",
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const classification = checkpointClassifications.get(statement);
        const execute = () => {
          let arrays = false;
          let result: Exit.Exit<ReadonlyArray<unknown>, SqlError>;
          try {
            const value = withClassification(classification, () => {
              const bindable = sqliteParameters(params);
              statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
              if (hasRows(statement)) {
                arrays = mode === "values";
                if (arrays) statement.setReturnArrays(true);
                return statement.all(...(bindable as any));
              }
              const result = statement.run(...(bindable as any));
              return mode === "raw" ? (result as unknown as ReadonlyArray<unknown>) : [];
            });
            result = Exit.succeed(value);
          } catch (cause) {
            result = Exit.fail(
              new SqlError({
                reason: classifyError(cause, "Failed to execute statement", "execute"),
              }),
            );
          } finally {
            // OR FAIL may have committed earlier rows even when execution throws.
            if (classification?.check) checkpoint?.check();
          }
          if (arrays) {
            try {
              statement.setReturnArrays(false);
            } catch (cause) {
              return Exit.die(
                new SqlError({
                  reason: classifyError(
                    cause,
                    "Failed to reset statement result mode",
                    "resetResultMode",
                  ),
                }),
              );
            }
          }
          return result;
        };
        return checkpoint !== undefined && classification?.backpressure
          ? checkpoint.runWithAdmission(execute)
          : execute();
      }).pipe(waitForWalRecovery);

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatement(statement, params, raw ? "raw" : "rows"),
      );
    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatement(statement, params, "values"),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatement(statement, params ?? [], "values"),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = prepare(sql).pipe(
          Effect.flatMap((statement) => runStatement(statement, params ?? [])),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;
  const acquireReader =
    options.readerWorker && isFileDatabase ? yield* makeReader(options) : undefined;
  const readerSemaphore = yield* Semaphore.make(1);
  let admittedReaders = 0;
  const admit = (target: { readonly name: Acquired["connection"] }) =>
    Effect.suspend(() => {
      if (target.name !== "reader") return Effect.void;
      if (admittedReaders >= 64)
        return Effect.fail(
          failed(
            new Error("Reader admission limit reached"),
            "Database reader overloaded",
            "acquire",
          ),
        );
      admittedReaders++;
      return Effect.void;
    });
  const releaseAdmission = (target: { readonly name: Acquired["connection"] }) =>
    Effect.sync(() => {
      if (target.name === "reader") admittedReaders--;
    });

  const writer = { name: "writer" as const, lock: semaphore, connection };
  let activeWriter: ConnectionOwner | undefined;
  const route = Effect.withFiber<
    {
      readonly name: Acquired["connection"];
      readonly lock: Semaphore.Semaphore;
      readonly connection: Connection;
    },
    SqlError
  >((fiber) =>
    acquireReader !== undefined && Context.get(fiber.context, ReadOnly)
      ? Effect.map(acquireReader, (readerConnection) => ({
          name: "reader" as const,
          lock: readerSemaphore,
          connection: readerConnection,
        }))
      : Effect.succeed(writer),
  );

  const acquired = (
    target: { readonly name: Acquired["connection"] },
    clock: Clock.Clock,
    start: bigint,
  ): Acquired => ({
    connection: target.name,
    lockWaitMs: Number((clock.monotonicTimeNanosUnsafe() - start) / 1000n) / 1000,
  });

  const writerBorrowBatchSize = 16;
  let writerBorrowsSinceYield = 0;
  const candidate = Effect.withFiber((fiber) =>
    Effect.succeed({
      name:
        acquireReader !== undefined && Context.get(fiber.context, ReadOnly)
          ? ("reader" as const)
          : ("writer" as const),
    }),
  );
  const borrower: Borrower = (use) =>
    Effect.flatMap(candidate, (candidate) =>
      Effect.acquireUseRelease(
        admit(candidate),
        () =>
          Effect.flatMap(route, (target) =>
            Effect.withFiber((fiber) => {
              const clock = fiber.getRef(Clock.Clock);
              const start = clock.monotonicTimeNanosUnsafe();
              const ownerAtWaitStart = target.name === "writer" ? activeWriter : undefined;
              const owner = target.name === "writer" ? connectionOwner(fiber) : undefined;
              const useConnection = Effect.suspend(() => {
                if (target.name === "writer") activeWriter = owner;
                if (
                  fiber.getRef(References.TracerEnabled) &&
                  fiber.getRef(Statement.SpanPropagationEnabled)
                ) {
                  annotateAcquired(fiber, acquired(target, clock, start), ownerAtWaitStart);
                }
                return use(target.connection);
              });
              const useOwnedConnection =
                target.name === "writer"
                  ? Effect.onExit(useConnection, () =>
                      Effect.sync(() => {
                        if (activeWriter === owner) activeWriter = undefined;
                      }),
                    )
                  : useConnection;
              if (!options.checkpointWorker || target.name !== "writer") {
                return target.lock.withPermits(1)(useOwnedConnection);
              }
              const writerUse = Effect.onExit(useOwnedConnection, (exit) =>
                Effect.sync(() => {
                  writerBorrowsSinceYield = Exit.hasInterrupts(exit)
                    ? 0
                    : Math.min(writerBorrowsSinceYield + 1, writerBorrowBatchSize);
                }),
              );
              return Effect.flatMap(target.lock.withPermitsIfAvailable(1)(writerUse), (result) =>
                Option.isSome(result)
                  ? Effect.succeed(result.value)
                  : target.lock.withPermits(1)(
                      Effect.andThen(
                        // Failed SQL also consumes the batch; cancellation hands off immediately.
                        Effect.suspend(() => {
                          if (writerBorrowsSinceYield < writerBorrowBatchSize) return Effect.void;
                          writerBorrowsSinceYield = 0;
                          return Effect.callback<void>((resume) => {
                            const immediate = setImmediate(() => resume(Effect.void));
                            return Effect.sync(() => clearImmediate(immediate));
                          });
                        }),
                        writerUse,
                      ),
                    ),
              );
            }),
          ),
        () => releaseAdmission(candidate),
      ),
    );
  const transactionAcquirer = Effect.flatMap(candidate, (candidate) =>
    Effect.andThen(
      Effect.acquireRelease(admit(candidate), () => releaseAdmission(candidate)),
      Effect.flatMap(route, (target) =>
        Effect.uninterruptibleMask((restore) => {
          const fiber = Fiber.getCurrent()!;
          const scope = Context.getUnsafe(fiber.context, Scope.Scope);
          const clock = fiber.getRef(Clock.Clock);
          const start = clock.monotonicTimeNanosUnsafe();
          const pending = fiber.getRef(TransactionAcquire);
          const ownerAtWaitStart = target.name === "writer" ? activeWriter : undefined;
          const owner = target.name === "writer" ? connectionOwner(fiber) : undefined;
          const acquire = Effect.tap((pending?.restore ?? restore)(target.lock.take(1)), () => {
            if (target.name === "writer") activeWriter = owner;
            if (pending !== undefined) {
              pending.acquired = acquired(target, clock, start);
              pending.ownerAtWaitStart = ownerAtWaitStart;
            }
            return Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                if (target.name === "writer" && activeWriter === owner) activeWriter = undefined;
              }).pipe(Effect.andThen(target.lock.release(1))),
            );
          });
          return Effect.as(
            // A scheduler yield after taking the permit must not precede its release finalizer.
            Effect.provideService(acquire, Scheduler.PreventSchedulerYield, true),
            target.connection,
          );
        }),
      ),
    ),
  );

  const client = yield* Client.make({
    acquirer: transactionAcquirer,
    borrower,
    compiler,
    transactionAcquirer,
    // BEGIN IMMEDIATE avoids read-then-write SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot resolve.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
  const withTransaction = client.withTransaction;
  return Object.assign(client, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) => {
        // SqlClient masks setup; acquisition must preserve the caller's interruptibility.
        const pending: {
          acquired?: Acquired;
          ownerAtWaitStart: ConnectionOwner | undefined;
          restore: typeof Effect.interruptible | undefined;
        } = {
          ownerAtWaitStart: undefined,
          restore,
        };
        const body = Effect.withFiber<A, E, R>((fiber) => {
          annotateAcquired(fiber, pending.acquired, pending.ownerAtWaitStart);
          pending.restore = undefined;
          return effect;
        });
        return restore(
          withTransaction(body).pipe(Effect.provideService(TransactionAcquire, pending)),
        );
      }),
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
