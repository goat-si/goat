import * as NodeWorkerThreads from "node:worker_threads";
import { identity } from "effect/Function";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import type { SqliteClientConfig } from "./nodeSqliteClient.ts";
import { hasLargeBinding, sqliteParameters } from "./nodeSqliteParameters.ts";
import { writerWorkerSource } from "./sqliteWriterWorkerSource.ts";
import { connectionOwner, recordSlowSql } from "./slowSqlOperations.ts";

interface WorkerError {
  readonly operation: string;
  readonly message: string;
  readonly code?: unknown;
  readonly errcode?: unknown;
  readonly errstr?: unknown;
}
interface Reply {
  readonly id: number;
  readonly rows?: unknown;
  readonly completedAtMs?: number;
  readonly backpressure?: boolean;
  readonly walFrames?: number;
  readonly checkpointedFrames?: number;
  readonly prepareMs?: number;
  readonly nativeMs?: number;
  readonly error?: WorkerError;
}
type Startup =
  | { readonly type: "ready" }
  | ({ readonly type: "unavailable" } & Omit<WorkerError, "operation">);
type Notice = {
  readonly type: "maintenance-unavailable" | "maintenance-recovered" | "admission-recovered";
};
interface Request {
  readonly type?: "close";
  readonly sql?: string;
  readonly params?: ReadonlyArray<unknown>;
  readonly values?: boolean;
  readonly raw?: boolean;
  readonly cached?: boolean;
  readonly safeIntegers?: boolean;
  readonly owner?: number;
}
const isSqlError = Schema.is(SqlError);
const failure = (cause: unknown, operation: string) =>
  new SqlError({
    reason: classifySqliteError(cause, { message: "SQLite writer worker failed", operation }),
  });
const nativeFailure = (error: Omit<WorkerError, "operation">, operation: string) =>
  failure(Object.assign(new Error(error.message), error, { errno: error.errcode }), operation);

const cloneParameters = (params: ReadonlyArray<unknown>) =>
  params.map((param) =>
    typeof param === "function"
      ? Object.fromEntries(Object.keys(param).map((key) => [key, Reflect.get(param, key)]))
      : param,
  );

export const makeWriter = Effect.fn("SqliteWriter.make")(function* (
  options: SqliteClientConfig,
  recover: <A, R>(effect: Effect.Effect<A, SqlError, R>) => Effect.Effect<A, SqlError, R>,
  unsupportedStream: () => Error,
  admissionPolicy: () => typeof Effect.interruptible | undefined,
) {
  const isFileDatabase = options.filename !== ":memory:" && options.filename !== "";
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let initialized = false;
  let closing = false;
  let retirement: Promise<number> | undefined;
  const retire = (worker: NodeWorkerThreads.Worker) => (retirement ??= worker.terminate());
  const worker = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        new NodeWorkerThreads.Worker(writerWorkerSource, {
          eval: true,
          workerData: {
            filename: options.filename,
            readonly: options.readonly ?? false,
            allowExtension: options.allowExtension ?? false,
            checkpoint: isFileDatabase && Boolean(options.checkpointWorker),
            protectJournal:
              isFileDatabase && Boolean(options.readerWorker || options.checkpointWorker),
            prepareCacheSize: options.prepareCacheSize ?? 200,
            prepareCacheTTL: Duration.toMillis(
              Duration.fromInputUnsafe(options.prepareCacheTTL ?? "10 minutes"),
            ),
          },
        }),
      catch: (cause) => {
        const error = failure(cause, "open");
        options.onFatalPersistence?.(error);
        return error;
      },
    }),
    (worker) =>
      Effect.promise(() => {
        closing = true;
        return retire(worker);
      }).pipe(Effect.catchCause(() => Effect.logWarning("SQLite writer retirement failed"))),
  );
  const requests = yield* Semaphore.make(1);
  let sequence = 0;
  let owner = 0;
  let stopped: SqlError | undefined;
  let pressureSince: number | undefined;
  let pressureDegraded = false;
  const clearPressure = Effect.suspend(() => {
    pressureSince = undefined;
    const recovered = pressureDegraded;
    pressureDegraded = false;
    return recovered ? Effect.logInfo("SQLite writer WAL admission recovered") : Effect.void;
  });
  let pending: { readonly id: number; readonly resume: (reply: Reply) => void } | undefined;
  const failPending = (cause: unknown) => {
    if (stopped !== undefined) return;
    stopped = failure(cause, "execute");
    if (!closing) options.onFatalPersistence?.(stopped);
    const request = pending;
    pending = undefined;
    request?.resume({
      id: request.id,
      error: { operation: "execute", message: "Writer exited; commit status may be unknown" },
    });
  };
  worker.on("error", failPending);
  worker.on("exit", (code) => failPending(new Error(`Writer exited with code ${code}`)));
  worker.on("message", (reply: Reply | Startup | Notice) => {
    if ("type" in reply) {
      if (reply.type === "admission-recovered") runFork(clearPressure);
      if (reply.type === "maintenance-unavailable")
        runFork(Effect.logWarning("SQLite writer checkpoint unavailable; mutations paused"));
      if (reply.type === "maintenance-recovered")
        runFork(Effect.logInfo("SQLite writer checkpoint recovered"));
      return;
    }
    if (reply.id !== pending?.id) return;
    const request = pending;
    pending = undefined;
    worker.unref();
    request?.resume(reply);
  });
  // Native work must finish before interruption can release the connection or roll it back.
  const send = Effect.fn("SqliteWriter.send")(function* (input: Request) {
    let delayed = false;
    const watchdog = yield* Effect.sleep("10 seconds").pipe(
      Effect.andThen(
        Effect.sync(() => {
          delayed = true;
        }),
      ),
      Effect.andThen(Effect.logWarning("SQLite writer request stalled; maintenance may be busy")),
      Effect.interruptible,
      Effect.forkChild({ startImmediately: true }),
    );
    return yield* Effect.callback<Reply, SqlError>((resume) => {
      if (stopped !== undefined) {
        resume(Effect.fail(stopped));
        return;
      }
      const id = ++sequence;
      pending = { id, resume: (reply) => resume(Effect.succeed(reply)) };
      worker.ref();
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers have no target origin.
        worker.postMessage({ id, ...input });
      } catch (cause) {
        pending = undefined;
        worker.unref();
        if (!(cause instanceof Error && cause.name === "DataCloneError")) failPending(cause);
        resume(Effect.fail(failure(cause, "execute")));
      }
    }).pipe(
      Effect.ensuring(Fiber.interrupt(watchdog)),
      Effect.onExit(() =>
        delayed ? Effect.logInfo("SQLite writer request stall cleared") : Effect.void,
      ),
    );
  }, Effect.uninterruptible);
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      closing = true;
      return initialized && stopped === undefined
        ? send({ type: "close" }).pipe(
            Effect.flatMap((reply) =>
              reply.error === undefined
                ? Effect.void
                : Effect.logWarning("SQLite writer close failed"),
            ),
            Effect.catch(() => Effect.logWarning("SQLite writer close failed")),
            requests.withPermits(1),
          )
        : Effect.void;
    }),
  );
  let startupRefused = false;
  yield* recover(
    Effect.callback<void, SqlError>((resume) => {
      startupRefused = false;
      const cleanup = () => {
        worker.off("message", ready);
        worker.off("error", error);
        worker.off("exit", exit);
      };
      const error = (cause: unknown) => {
        cleanup();
        resume(Effect.fail(failure(cause, "open")));
      };
      const exit = (code: number) => error(new Error(`Writer startup exited ${code}`));
      const ready = (reply: Reply | Startup | Notice) => {
        if (!("type" in reply)) return;
        if (reply.type === "ready") {
          cleanup();
          resume(Effect.void);
        }
        if (reply.type === "unavailable") {
          startupRefused = true;
          cleanup();
          resume(Effect.fail(nativeFailure(reply, "open")));
        }
      };
      if (worker.threadId === -1) {
        exit(-1);
        return;
      }
      worker.on("message", ready);
      worker.on("error", error);
      worker.on("exit", exit);
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers have no target origin.
        worker.postMessage({ type: "initialize" });
      } catch (cause) {
        error(cause);
      }
      return Effect.sync(cleanup);
    }),
  ).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) => (isSqlError(cause) ? cause : failure(cause, "open"))),
    Effect.onError((cause) =>
      Effect.sync(() => {
        if (!startupRefused && !Cause.hasInterruptsOnly(cause)) failPending(cause);
        // Return the startup error now; the owning scope still awaits native retirement.
        closing = true;
        worker.unref();
        retire(worker);
      }),
    ),
  );
  initialized = true;
  worker.unref();

  // SqlClient owns statement spans; preserve the caller's operation across the native bridge.
  const run = Effect.fnUntraced(function* (
    sql: string,
    params: ReadonlyArray<unknown>,
    values: boolean,
    raw: boolean,
    cached: boolean,
  ) {
    return yield* Effect.withFiber((fiber) => {
      const name = connectionOwner(fiber).name;
      const restoreAdmission = admissionPolicy() ?? identity;
      if (/^\s*BEGIN\b/i.test(sql)) owner++;
      return Effect.try({
        try: () => ({
          sql,
          params: cloneParameters(sqliteParameters(params)),
          values,
          raw,
          cached: cached && !hasLargeBinding(params),
          safeIntegers: Boolean(Context.get(fiber.context, Client.SafeIntegers)),
          owner,
        }),
        catch: (cause) => failure(cause, "execute"),
      }).pipe(
        Effect.flatMap((input) => {
          const attempt = Effect.gen(function* () {
            const reply = yield* send(input);
            if (reply.backpressure) {
              const now = yield* Clock.currentTimeMillis;
              pressureSince ??= now;
              if (!pressureDegraded && now - pressureSince >= 10_000) {
                pressureDegraded = true;
                yield* Effect.logWarning(
                  `SQLite writer WAL admission degraded; walFrames=${reply.walFrames} checkpointedFrames=${reply.checkpointedFrames}`,
                );
              }
              return yield* Effect.fail({ _tag: "WriterBackpressure" } as const);
            }
            if (reply.backpressure === false) yield* clearPressure;
            for (const [operation, nativeMs] of [
              ["prepare", reply.prepareMs],
              ["execute", reply.nativeMs],
            ] as const) {
              if (nativeMs !== undefined && reply.completedAtMs !== undefined)
                recordSlowSql({
                  connection: "writer",
                  operation,
                  owner: name,
                  nativeMs,
                  completedAtMs: reply.completedAtMs,
                });
            }
            if (reply.error !== undefined)
              return yield* nativeFailure(reply.error, reply.error.operation);
            if (!("rows" in reply))
              return yield* failure(new Error("Invalid writer reply"), "decode");
            return reply.rows;
          });
          return recover(
            attempt.pipe(
              Effect.retry({
                // BEGIN is masked by SqlClient, but refusal means no SQL has executed.
                while: (error) =>
                  error._tag === "WriterBackpressure"
                    ? Effect.as(restoreAdmission(Effect.sleep("100 millis")), true)
                    : false,
              }),
              Effect.mapError((error) => (isSqlError(error) ? error : failure(error, "acquire"))),
            ),
          );
        }),
      );
    });
  }, requests.withPermits(1));
  const objects = (result: unknown) =>
    Effect.try({
      try: () => {
        if (!Array.isArray(result)) throw new Error("Invalid object-row reply");
        return result.map((row: unknown) => {
          if (typeof row !== "object" || row === null || Array.isArray(row))
            throw new Error("Invalid object-row reply");
          return row;
        });
      },
      catch: (cause) => failure(cause, "decode"),
    });
  const values = (result: unknown) =>
    Effect.try({
      try: () => {
        if (!Array.isArray(result)) throw new Error("Invalid values reply");
        return result.map((row: unknown): ReadonlyArray<unknown> => {
          if (!Array.isArray(row)) throw new Error("Invalid values reply");
          return row;
        });
      },
      catch: (cause) => failure(cause, "decode"),
    });
  const connection = identity<Connection>({
    execute(sql, params, transform) {
      const rows = run(sql, params, false, false, true).pipe(Effect.flatMap(objects));
      return transform ? Effect.map(rows, transform) : rows;
    },
    executeRaw: (sql, params) => run(sql, params, false, true, true),
    executeValues: (sql, params) =>
      run(sql, params, true, false, true).pipe(Effect.flatMap(values)),
    executeValuesUnprepared: (sql, params) =>
      run(sql, params ?? [], true, false, false).pipe(Effect.flatMap(values)),
    executeUnprepared(sql, params, transform) {
      const rows = run(sql, params ?? [], false, false, false).pipe(Effect.flatMap(objects));
      return transform ? Effect.map(rows, transform) : rows;
    },
    executeStream: () => Stream.die(unsupportedStream()),
  });
  return {
    connection,
    available: Effect.suspend(() => (stopped === undefined ? Effect.void : Effect.fail(stopped))),
  };
});
