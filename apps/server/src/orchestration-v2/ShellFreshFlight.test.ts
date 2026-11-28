import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import { makeFreshFlight } from "./ShellFreshFlight.ts";

it.effect("a caller arriving after a mutation does not join an older snapshot", () =>
  Effect.gen(function* () {
    const flight = yield* makeFreshFlight<number, Error>(() => new Error("sequence regressed"));
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let sequence = 0;
    let reads = 0;
    const barrier = Effect.sync(() => sequence);
    const build = Effect.sync(() => ({ sequence, value: ++reads })).pipe(
      Effect.flatMap((snapshot) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(snapshot),
        ),
      ),
    );
    const first = yield* flight
      .run("active", barrier, build)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    sequence = 1;
    const second = yield* flight
      .run("active", barrier, build)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    expect(reads).toBe(2);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(first)).toBe(1);
    expect(yield* Fiber.join(second)).toBe(2);
    expect(reads).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect("a sequence regression fails rather than repeatedly rebuilding", () =>
  Effect.gen(function* () {
    const flight = yield* makeFreshFlight<number, string>(
      (minimum, observed) => `${minimum}:${observed}`,
    );
    const error = yield* flight
      .run("active", Effect.succeed(2), Effect.succeed({ sequence: 1, value: 1 }))
      .pipe(Effect.flip);
    expect(error).toBe("2:1");
  }).pipe(Effect.scoped),
);

it.effect("callers at the same sequence share an in-flight snapshot", () =>
  Effect.gen(function* () {
    const flight = yield* makeFreshFlight<number, Error>(() => new Error("sequence regressed"));
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    const build = Effect.sync(() => ({ sequence: 4, value: ++reads })).pipe(
      Effect.flatMap((snapshot) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(snapshot),
        ),
      ),
    );
    const first = yield* flight
      .run("active", Effect.succeed(4), build)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    const second = yield* flight
      .run("active", Effect.succeed(4), build)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(first)).toBe(1);
    expect(yield* Fiber.join(second)).toBe(1);
    expect(reads).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("a committed mutation between callers fences an in-flight database snapshot", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-shell-flight-" });
    const filename = path.join(directory, "state.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE changes(sequence INTEGER PRIMARY KEY, value TEXT NOT NULL)`;
      yield* sql`INSERT INTO changes VALUES (1, 'before')`;
      const flight = yield* makeFreshFlight<string, SqlError.SqlError | Error>(
        () => new Error("sequence regressed"),
      );
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const barrier = sql<{
        readonly sequence: number;
      }>`SELECT MAX(sequence) AS sequence FROM changes`.pipe(
        SqliteClient.readOnly,
        Effect.map((rows) => rows[0]!.sequence),
      );
      const build = sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly sequence: number; readonly value: string }>`
          SELECT sequence, value FROM changes ORDER BY sequence DESC LIMIT 1`;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return rows[0]!;
          }),
        )
        .pipe(SqliteClient.readOnly);
      const first = yield* flight
        .run("active", barrier, build)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* sql`INSERT INTO changes VALUES (2, 'after')`;
      const second = yield* flight
        .run("active", barrier, build)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toBe("before");
      expect(yield* Fiber.join(second)).toBe("after");
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename, readerWorker: true, writerWorker: true, readerPoolSize: 2 }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
