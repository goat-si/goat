// @effect-diagnostics nodeBuiltinImport:off -- workers and SQLite fixtures exercise the native boundary.
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as AuxiliarySqlite from "./AuxiliarySqlite.ts";
import { source } from "./AuxiliarySqliteWorkerSource.ts";

const output = (worktreePaths: string[] = []): AuxiliarySqlite.AuxiliaryRows => ({
  worktreePaths,
  projectRoots: [],
  rows: [],
  max: 0,
});
const complete = (worktreePaths: string[] = []) => ({
  type: "complete",
  output: output(worktreePaths),
});

type Receipts = Parameters<AuxiliarySqlite.WorkerLauncher["Service"]["start"]>[1];
const workerFixture = Effect.gen(function* () {
  const starts = yield* Queue.unbounded<{
    readonly nativeStarted: Deferred.Deferred<void>;
    readonly result: Deferred.Deferred<unknown>;
    readonly termination: Deferred.Deferred<void>;
    readonly actualExit: Deferred.Deferred<number>;
    readonly retirement: Deferred.Deferred<void>;
    readonly message: Receipts["message"];
    readonly error: Receipts["error"];
    readonly exit: Receipts["exit"];
  }>();
  let spawned = 0;
  const launcher = Layer.succeed(AuxiliarySqlite.WorkerLauncher, {
    start: (_input, receipts) => {
      spawned += 1;
      const nativeStarted = Deferred.makeUnsafe<void>();
      const result = Deferred.makeUnsafe<unknown>();
      const termination = Deferred.makeUnsafe<void>();
      const actualExit = Deferred.makeUnsafe<number>();
      const retirement = Deferred.makeUnsafe<void>();
      Deferred.doneUnsafe(nativeStarted, Effect.void);
      Queue.offerUnsafe(starts, {
        nativeStarted,
        result,
        termination,
        actualExit,
        retirement,
        message: (value) => {
          Deferred.doneUnsafe(result, Effect.succeed(value));
          receipts.message(value);
        },
        error: receipts.error,
        exit: (code) => {
          Deferred.doneUnsafe(actualExit, Effect.succeed(code));
          receipts.exit(code);
          Deferred.doneUnsafe(retirement, Effect.void);
        },
      });
      return {
        terminate: () => {
          Deferred.doneUnsafe(termination, Effect.void);
        },
        // Deliberately allow late fixture replies to exercise the owner's identity guard.
        detach: () => {},
      };
    },
  });
  return {
    starts,
    spawned: () => spawned,
    layer: AuxiliarySqlite.layerWithLauncher.pipe(Layer.provide(launcher)),
  };
});

it.effect(
  "quarantines timed-out workers until actual exit and ignores late results after replacement",
  () =>
    Effect.gen(function* () {
      const fixture = yield* workerFixture;
      yield* Effect.gen(function* () {
        const reader = yield* AuxiliarySqlite.AuxiliarySqlite;
        const read = reader.read({ kind: "worktrees", file: "fixture" });
        const a = yield* read.pipe(Effect.result, Effect.forkChild);
        const first = yield* Queue.take(fixture.starts);
        yield* Deferred.await(first.nativeStarted);
        const b = yield* read.pipe(Effect.result, Effect.forkChild);
        const second = yield* Queue.take(fixture.starts);
        yield* Deferred.await(second.nativeStarted);
        yield* TestClock.adjust("5 seconds");
        expect((yield* Fiber.join(a))._tag).toBe("Failure");
        expect((yield* Fiber.join(b))._tag).toBe("Failure");
        yield* Deferred.await(first.termination);
        yield* Deferred.await(second.termination);
        expect((yield* Effect.result(read))._tag).toBe("Failure");
        expect(fixture.spawned()).toBe(2);
        first.exit(1);
        yield* Deferred.await(first.actualExit);
        yield* Deferred.await(first.retirement);
        const c = yield* read.pipe(Effect.forkChild);
        const third = yield* Queue.take(fixture.starts);
        first.message(complete(["/stale"]));
        expect((yield* Effect.result(read))._tag).toBe("Failure");
        expect(fixture.spawned()).toBe(3);
        third.message(complete(["/replacement"]));
        yield* Deferred.await(third.result);
        third.exit(0);
        expect((yield* Fiber.join(c)).worktreePaths).toEqual(["/replacement"]);
        second.exit(1);
      }).pipe(Effect.provide(fixture.layer));
    }),
);

it.effect(
  "cancellation and scope shutdown fail outstanding reads without claiming retirement",
  () =>
    Effect.gen(function* () {
      const fixture = yield* workerFixture;
      const scope = yield* Scope.make();
      const context = yield* Layer.build(fixture.layer).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const reader = Context.get(context, AuxiliarySqlite.AuxiliarySqlite);
      const read = reader.read({ kind: "worktrees", file: "fixture" });
      const canceled = yield* read.pipe(Effect.forkChild);
      const first = yield* Queue.take(fixture.starts);
      yield* Fiber.interrupt(canceled);
      yield* Deferred.await(first.termination);
      const pending = yield* read.pipe(Effect.result, Effect.forkChild);
      const second = yield* Queue.take(fixture.starts);
      expect((yield* Effect.result(read))._tag).toBe("Failure");
      yield* Scope.close(scope, Exit.void);
      expect((yield* Fiber.join(pending))._tag).toBe("Failure");
      yield* Deferred.await(second.termination);
      expect((yield* Effect.result(read))._tag).toBe("Failure");
      expect(fixture.spawned()).toBe(2);
      first.exit(1);
      second.exit(1);
    }),
);

it.effect("worker exit, malformed result and failed close never expose partial ownership", () =>
  Effect.gen(function* () {
    const fixture = yield* workerFixture;
    yield* Effect.gen(function* () {
      const reader = yield* AuxiliarySqlite.AuxiliarySqlite;
      for (const reply of [
        undefined,
        { type: "complete", output: { ...output(["/partial"]), rows: [{}] } },
        { type: "failed", category: "query_failed", message: "auxiliary close unavailable" },
        { type: "failed", category: "schema_unsupported" },
      ]) {
        const fiber = yield* reader
          .read({ kind: "worktrees", file: "fixture" })
          .pipe(Effect.result, Effect.forkChild);
        const worker = yield* Queue.take(fixture.starts);
        if (reply !== undefined) worker.message(reply);
        worker.exit(reply === undefined ? 1 : 0);
        const result = yield* Fiber.join(fiber);
        expect(result._tag).toBe("Failure");
        if (
          reply?.type === "failed" &&
          reply.category === "schema_unsupported" &&
          result._tag === "Failure"
        )
          expect(result.failure.category).toBe("schema_unsupported");
      }
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("invalid Messages ranges reject before starting native work", () =>
  Effect.gen(function* () {
    const fixture = yield* workerFixture;
    yield* Effect.gen(function* () {
      const reader = yield* AuxiliarySqlite.AuxiliarySqlite;
      for (const input of [
        { kind: "imessage-rows", file: "fixture", cursor: -1, limit: 1 },
        { kind: "imessage-rows", file: "fixture", cursor: 0, limit: 51 },
        { kind: "imessage-row", file: "fixture", rowId: 0 },
      ] as const)
        expect((yield* Effect.result(reader.read(input)))._tag).toBe("Failure");
      expect(fixture.spawned()).toBe(0);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("spawn failure releases unused capacity without leaking native error text", () => {
  let spawns = 0;
  const launcher = Layer.succeed(AuxiliarySqlite.WorkerLauncher, {
    start: () => {
      spawns += 1;
      throw new Error("private fixture");
    },
  });
  return Effect.gen(function* () {
    const reader = yield* AuxiliarySqlite.AuxiliarySqlite;
    for (let index = 0; index < 3; index++) {
      const result = yield* Effect.result(reader.read({ kind: "worktrees", file: "fixture" }));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).not.toContain("private fixture");
    }
    expect(spawns).toBe(3);
  }).pipe(Effect.provide(AuxiliarySqlite.layerWithLauncher.pipe(Layer.provide(launcher))));
});

it.effect("real inline workers bound ownership rows and bytes and discard every partial path", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = path.join(dir, "foreign.sqlite");
    const writer = new NodeSqlite.DatabaseSync(file);
    try {
      writer.exec("CREATE TABLE orchestration_v2_projection_threads (payload_json TEXT)");
      writer.exec(
        'WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<100001) INSERT INTO orchestration_v2_projection_threads SELECT \'{"worktreePath":"/kept"}\' FROM rows',
      );
    } finally {
      writer.close();
    }
    const reader = yield* AuxiliarySqlite.AuxiliarySqlite;
    expect((yield* Effect.result(reader.read({ kind: "worktrees", file })))._tag).toBe("Failure");
    const update = new NodeSqlite.DatabaseSync(file);
    try {
      update.exec("DELETE FROM orchestration_v2_projection_threads");
      update
        .prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?)")
        .run(JSON.stringify({ worktreePath: "x".repeat(8 * 1024 * 1024 + 1) }));
    } finally {
      update.close();
    }
    expect((yield* Effect.result(reader.read({ kind: "worktrees", file })))._tag).toBe("Failure");
  }).pipe(Effect.provide(AuxiliarySqlite.layer), Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a real native close failure rejects a successful ownership query", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(yield* fs.makeTempDirectoryScoped(), "foreign.sqlite");
    const seed = new NodeSqlite.DatabaseSync(file);
    seed.exec("CREATE TABLE orchestration_v2_projection_threads (payload_json TEXT)");
    seed.close();
    const reader = yield* AuxiliarySqlite.AuxiliarySqlite;
    expect((yield* Effect.result(reader.read({ kind: "worktrees", file })))._tag).toBe("Failure");
  }).pipe(
    Effect.provide(
      AuxiliarySqlite.layerWithLauncher.pipe(
        Layer.provide(
          Layer.succeed(AuxiliarySqlite.WorkerLauncher, {
            start: (input, receipts) => {
              const worker = new NodeWorkerThreads.Worker(
                'require("node:sqlite").DatabaseSync.prototype.close = () => { throw new Error("fixture close"); };\n' +
                  source,
                { eval: true, workerData: input },
              );
              worker.on("message", receipts.message);
              worker.on("error", receipts.error);
              worker.once("exit", receipts.exit);
              return {
                terminate: () => {
                  void worker.terminate().catch(receipts.error);
                },
                detach: () => {
                  worker.off("message", receipts.message);
                },
              };
            },
          }),
        ),
      ),
    ),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);

it.live("cancels a real held worker and admits a successful read after its actual exit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(yield* fs.makeTempDirectoryScoped(), "foreign.sqlite");
    const seed = new NodeSqlite.DatabaseSync(file);
    seed.exec(
      'CREATE TABLE orchestration_v2_projection_threads (payload_json TEXT); INSERT INTO orchestration_v2_projection_threads VALUES (\'{"worktreePath":"/kept"}\')',
    );
    seed.close();
    const started = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<void>();
    let first = true;
    const launcher = Layer.succeed(AuxiliarySqlite.WorkerLauncher, {
      start: (input, receipts) => {
        const held = first;
        first = false;
        const prefix = held
          ? `
          const sqlite = require("node:sqlite");
          const prepare = sqlite.DatabaseSync.prototype.prepare;
          sqlite.DatabaseSync.prototype.prepare = function(...args) {
            const statement = prepare.apply(this, args);
            require("node:worker_threads").parentPort.postMessage({ type: "native-start" });
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            return statement;
          };
        `
          : "";
        const worker = new NodeWorkerThreads.Worker(prefix + source, {
          eval: true,
          workerData: input,
        });
        const message = (value: unknown) => {
          if (
            typeof value === "object" &&
            value !== null &&
            "type" in value &&
            value.type === "native-start"
          )
            Deferred.doneUnsafe(started, Effect.void);
          else receipts.message(value);
        };
        worker.on("message", message);
        worker.on("error", receipts.error);
        worker.once("exit", (code) => {
          receipts.exit(code);
          if (held) Deferred.doneUnsafe(exited, Effect.void);
        });
        return {
          terminate: () => {
            void worker.terminate().catch(receipts.error);
          },
          detach: () => {
            worker.off("message", message);
          },
        };
      },
    });
    yield* Effect.gen(function* () {
      const reader = yield* AuxiliarySqlite.AuxiliarySqlite;
      const read = reader.read({ kind: "worktrees", file });
      const pending = yield* read.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(pending);
      yield* Deferred.await(exited);
      expect((yield* read).worktreePaths).toEqual(["/kept"]);
    }).pipe(Effect.provide(AuxiliarySqlite.layerWithLauncher.pipe(Layer.provide(launcher))));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
