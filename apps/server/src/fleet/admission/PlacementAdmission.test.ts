// @effect-diagnostics nodeBuiltinImport:off - each test gets a scratch database folder.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type CommandId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { countHostThreads } from "../../mcp/hostStatusModel.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { makeHarness } from "../../orchestration-v2/testkit/ThreadLaunchHarness.ts";
import { launchInput } from "../../orchestration-v2/testkit/threadLaunchInput.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as FleetHostStates from "../health/FleetHostStates.ts";
import * as Admission from "./PlacementAdmission.ts";
import { PlacementAdmissionEnabled, placementCommandId } from "./PlacementKey.ts";
import * as Reservations from "./PlacementReservations.ts";

const T0 = Date.UTC(2026, 10, 1);
const freshFile = () =>
  NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "placement-admission-")),
    "state.sqlite",
  );

const admissionOn = (file: string, maxThreads?: number) => {
  const harness = makeHarness({
    runSetup: () => Effect.never,
    databaseLayer: Layer.orDie(
      SqlitePersistence.layerFromPath(file).pipe(Layer.provide(NodeServices.layer)),
    ),
    ...(maxThreads === undefined
      ? {}
      : { serverSettings: { fleet: { hosts: { local: { maxThreads } } } } }),
  });
  return Admission.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Reservations.layer, FleetHostStates.layer)),
    Layer.provideMerge(harness.layer),
    Layer.provide(Layer.succeed(PlacementAdmissionEnabled, true)),
  );
};
const admission = (maxThreads?: number) => admissionOn(freshFile(), maxThreads);

const key = (ownerKey: string, placer = "pen:node-a"): Reservations.PlacementKey => ({
  placer,
  ownerKey,
  attempt: 0,
  issuedAt: T0,
});

interface Launcher {
  readonly calls: Ref.Ref<number>;
  /** Resolved when the launch has created its thread and is about to send its first message. */
  readonly beforeMessage: Deferred.Deferred<void>;
  /** Released by the test to let the first message commit. */
  readonly gate: Deferred.Deferred<void>;
  /** Resolved when the launch effect has ended, however it ended. */
  readonly finished: Deferred.Deferred<void>;
  readonly launch: (commandId: CommandId) => Effect.Effect<unknown, unknown>;
}

const makeLauncher = (options: { readonly hold?: boolean; readonly failAfter?: boolean } = {}) =>
  Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const calls = yield* Ref.make(0);
    const beforeMessage = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    if (options.hold !== true) yield* Deferred.succeed(gate, undefined);
    const launch = (commandId: CommandId) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (count) => count + 1);
        let step = 0;
        const confirm = Effect.suspend(() => {
          step += 1;
          return step < 2
            ? Effect.succeed(true)
            : Deferred.succeed(beforeMessage, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.as(true),
              );
        });
        yield* launches.launch({
          ...launchInput({ command: commandId, thread: commandId, message: "go " + commandId }),
          confirm,
        });
        if (options.failAfter === true) return yield* Effect.fail("failed after the run existed");
      }).pipe(Effect.ensuring(Deferred.succeed(finished, undefined)));
    return { calls, beforeMessage, gate, finished, launch } satisfies Launcher;
  });

const runningCount = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shells = yield* threads.listProjectThreads({
    projectId: undefined,
    includeSubagents: true,
  });
  const counts = countHostThreads(shells);
  return counts.running + counts.queued;
});

/** The ids an answer names; the launch's own result rides only on the call that ran or joined it. */
const ids = (answer: Admission.PlacementAnswer) =>
  answer._tag === "Started" ? [answer.threadId, answer.runId] : answer._tag;

const place = (k: Reservations.PlacementKey, launcher: Launcher, digest = "digest-1") =>
  Effect.flatMap(Admission.PlacementAdmission, (service) =>
    service.place({ key: k, digest, launch: launcher.launch }),
  );

describe("placement admission on the target", () => {
  it.effect(
    "with maxThreads 1, a placement held between thread.create and its first message makes a new key full, and its retry joins and returns the first launch",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const held = yield* makeLauncher({ hold: true });
        const first = yield* place(key("a"), held).pipe(Effect.forkChild);
        yield* Deferred.await(held.beforeMessage);
        const other = yield* makeLauncher();
        assert.deepStrictEqual(yield* place(key("b"), other), { _tag: "Refused", refusal: "full" });
        assert.strictEqual(yield* Ref.get(other.calls), 0);
        const retry = yield* place(key("a"), held).pipe(Effect.forkChild);
        yield* Deferred.succeed(held.gate, undefined);
        const [a, again] = [yield* Fiber.join(first), yield* Fiber.join(retry)];
        assert.strictEqual(a._tag, "Started");
        assert.deepStrictEqual(again, a);
        assert.strictEqual(yield* Ref.get(held.calls), 1);
        assert.strictEqual(yield* runningCount, 1);
        // Counted now through the live projection: still full for a new key.
        assert.deepStrictEqual(yield* place(key("c"), other), { _tag: "Refused", refusal: "full" });
      }).pipe(Effect.provide(admission(1))),
  );

  it.effect("simultaneous duplicates start exactly one launch", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const launcher = yield* makeLauncher();
      const answers = yield* Effect.all(
        Array.from({ length: 4 }, () => place(key("dup"), launcher)),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(yield* Ref.get(launcher.calls), 1);
      assert.isTrue(answers.every((answer) => answer._tag === "Started"));
      assert.strictEqual(new Set(answers.map((answer) => JSON.stringify(ids(answer)))).size, 1);
    }).pipe(Effect.provide(admission())),
  );

  it.effect(
    "a counted retry returns the run id, and a different digest for the same key is conflicting",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const launcher = yield* makeLauncher();
        const first = yield* place(key("counted"), launcher);
        assert.strictEqual(first._tag, "Started");
        const retry = yield* place(key("counted"), launcher);
        assert.deepStrictEqual(ids(retry), ids(first));
        assert.isUndefined(retry._tag === "Started" ? retry.launched : "not started");
        assert.isTrue(retry._tag === "Started" && retry.runId.length > 0);
        assert.deepStrictEqual(yield* place(key("counted"), launcher, "digest-2"), {
          _tag: "Conflicting",
        });
        assert.strictEqual(yield* Ref.get(launcher.calls), 1);
      }).pipe(Effect.provide(admission())),
  );

  it.effect("a failure returned after the run was created reports started", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const launcher = yield* makeLauncher({ failAfter: true });
      const answer = yield* place(key("late-failure"), launcher);
      assert.strictEqual(answer._tag, "Started");
    }).pipe(Effect.provide(admission())),
  );

  it.effect(
    "a placement fenced after its thread exists reads not started with the thread id, never commits its run, and reads expired once pruned",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const held = yield* makeLauncher({ hold: true });
        const commandId = placementCommandId(key("slow"));
        const first = yield* place(key("slow"), held).pipe(Effect.forkChild);
        yield* Deferred.await(held.beforeMessage);
        const store = yield* Reservations.PlacementReservations;
        // The sweep at the 60-minute cap; the background sweep may also get there, with the same result.
        yield* store.sweep(T0 + Reservations.PENDING_CAP_MS + 1);
        const answer = yield* place(key("slow"), held);
        assert.strictEqual(answer._tag, "NotStarted");
        assert.strictEqual(answer._tag === "NotStarted" ? answer.threadId : null, commandId);
        yield* Deferred.succeed(held.gate, undefined);
        yield* Deferred.await(held.finished);
        assert.strictEqual((yield* Fiber.join(first))._tag, "NotStarted");
        const threads = yield* ThreadManagement.ThreadManagementService;
        const shell = yield* threads.getThreadShell(ThreadId.make(commandId));
        assert.isNull(shell?.latestRunId ?? null);
        assert.strictEqual(yield* runningCount, 0);
        assert.strictEqual((yield* store.get(commandId))?.state, "fenced");
        yield* store.prune(T0 + Reservations.RETAIN_MS + 1);
        assert.deepStrictEqual(yield* place(key("slow"), held), {
          _tag: "Refused",
          refusal: "expired",
        });
        assert.strictEqual(yield* Ref.get(held.calls), 1);
      }).pipe(Effect.provide(admission())),
  );

  it.effect("a joining retry whose wait runs out is told pending, and the launch goes on", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const held = yield* makeLauncher({ hold: true });
      const first = yield* place(key("wait"), held).pipe(Effect.forkChild);
      yield* Deferred.await(held.beforeMessage);
      const retry = yield* place(key("wait"), held).pipe(
        Effect.provideService(Admission.JoinWait, Duration.zero),
      );
      assert.deepStrictEqual(retry, { _tag: "Pending" });
      yield* Deferred.succeed(held.gate, undefined);
      assert.strictEqual((yield* Fiber.join(first))._tag, "Started");
      assert.strictEqual(yield* Ref.get(held.calls), 1);
    }).pipe(Effect.provide(admission())),
  );

  it.effect(
    "a dropped request does not fence its launch: the owner finishes it and a retry reads started",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const held = yield* makeLauncher({ hold: true });
        const request = yield* place(key("dropped"), held).pipe(Effect.forkChild);
        yield* Deferred.await(held.beforeMessage);
        yield* Fiber.interrupt(request);
        yield* Deferred.succeed(held.gate, undefined);
        const answer = yield* place(key("dropped"), held);
        assert.strictEqual(answer._tag, "Started");
        assert.strictEqual(yield* Ref.get(held.calls), 1);
      }).pipe(Effect.provide(admission())),
  );

  it.effect("a cordon set while a placement is pending lets it finish and refuses later keys", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const held = yield* makeLauncher({ hold: true });
      const first = yield* place(key("before"), held).pipe(Effect.forkChild);
      yield* Deferred.await(held.beforeMessage);
      const states = yield* FleetHostStates.FleetHostStates;
      yield* states.cordon({
        host: FleetHostStates.LOCAL_HOST,
        draining: false,
        reason: null,
        changedBy: null,
      });
      const other = yield* makeLauncher();
      assert.deepStrictEqual(yield* place(key("after"), other), {
        _tag: "Refused",
        refusal: "cordoned",
      });
      yield* Deferred.succeed(held.gate, undefined);
      assert.strictEqual((yield* Fiber.join(first))._tag, "Started");
    }).pipe(Effect.provide(admission())),
  );

  it.effect.each([0, 1, 2, 3, 4, 5])(
    "a new key racing the counted transition is full, never admitted (round %s)",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const held = yield* makeLauncher({ hold: true });
        const first = yield* place(key("hold"), held).pipe(Effect.forkChild);
        yield* Deferred.await(held.beforeMessage);
        const other = yield* makeLauncher();
        const [, raced] = yield* Effect.all(
          [Deferred.succeed(held.gate, undefined), place(key("race"), other)],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(raced, { _tag: "Refused", refusal: "full" });
        assert.strictEqual((yield* Fiber.join(first))._tag, "Started");
      }).pipe(Effect.provide(admission(1))),
  );

  it.effect(
    "a storage failure after the counted write rolls back the run and the count together",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const sql = yield* SqlClient.SqlClient;
        // Fails the receipt upsert that commitCommand runs after the guard, in the same transaction.
        yield* sql`
        CREATE TRIGGER fail_initial_message BEFORE UPDATE ON orchestration_command_receipts
        WHEN NEW.command_id LIKE '%:initial-message'
        BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END
      `;
        const launcher = yield* makeLauncher();
        const commandId = placementCommandId(key("rollback"));
        const answer = yield* place(key("rollback"), launcher);
        assert.strictEqual(answer._tag, "NotStarted");
        assert.strictEqual(answer._tag === "NotStarted" ? answer.threadId : null, commandId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        assert.isNull(
          (yield* threads.getThreadShell(ThreadId.make(commandId)))?.latestRunId ?? null,
        );
        assert.strictEqual(yield* runningCount, 0);
      }).pipe(Effect.provide(admission())),
  );

  it.effect(
    "one placer near full capacity leaves another only what remains; there is no per-member share",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const held = yield* makeLauncher({ hold: true });
        const fibers = [];
        for (const owner of ["a1", "a2"]) {
          fibers.push(yield* place(key(owner, "pen:node-a"), held).pipe(Effect.forkChild));
        }
        const other = yield* makeLauncher();
        assert.strictEqual((yield* place(key("b1", "pen:node-b"), other))._tag, "Started");
        assert.deepStrictEqual(yield* place(key("b2", "pen:node-b"), other), {
          _tag: "Refused",
          refusal: "full",
        });
        yield* Deferred.succeed(held.gate, undefined);
        for (const fiber of fibers) assert.strictEqual((yield* Fiber.join(fiber))._tag, "Started");
      }).pipe(Effect.provide(admission(3))),
  );

  it.effect("a placed launch refuses to run inside a caller's transaction", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const sql = yield* SqlClient.SqlClient;
      const launcher = yield* makeLauncher();
      const exit = yield* sql.withTransaction(place(key("in-tx"), launcher)).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(yield* Ref.get(launcher.calls), 0);
    }).pipe(Effect.provide(admission())),
  );
});

describe("owner lifetime and restart", () => {
  it.effect("shutting the service down fences a launch it still owned", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const file = freshFile();
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(admissionOn(file), scope);
      const commandId = placementCommandId(key("shutdown"));
      yield* Effect.gen(function* () {
        const held = yield* makeLauncher({ hold: true });
        yield* place(key("shutdown"), held).pipe(Effect.forkChild);
        yield* Deferred.await(held.beforeMessage);
      }).pipe(Effect.provide(context));
      yield* Scope.close(scope, Exit.void);
      const row = yield* Effect.flatMap(Reservations.PlacementReservations, (store) =>
        store.get(commandId),
      ).pipe(
        Effect.provide(
          Reservations.layer.pipe(
            Layer.provideMerge(
              Layer.orDie(
                SqlitePersistence.layerFromPath(file).pipe(Layer.provide(NodeServices.layer)),
              ),
            ),
          ),
        ),
      );
      assert.deepStrictEqual([row?.state, row?.reason], ["fenced", "launch interrupted"]);
    }),
  );

  it.effect(
    "a restart after thread.create fences the row before admission opens; the old owner's message then commits nothing and a replay queues nothing",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const file = freshFile();
        const commandId = placementCommandId(key("restart"));
        const firstScope = yield* Scope.make();
        const first = yield* Layer.buildWithScope(admissionOn(file), firstScope);
        const held = yield* Effect.gen(function* () {
          const launcher = yield* makeLauncher({ hold: true });
          yield* place(key("restart"), launcher).pipe(Effect.forkChild);
          yield* Deferred.await(launcher.beforeMessage);
          // The process that owned it is gone: nothing of it may count or renew any more.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE placement_reservations SET owner_epoch = 'dead' WHERE command_id = ${commandId}`;
          return launcher;
        }).pipe(Effect.provide(first));
        const secondScope = yield* Scope.make();
        const second = yield* Layer.buildWithScope(admissionOn(file), secondScope);
        yield* Effect.gen(function* () {
          const replay = yield* makeLauncher();
          const answer = yield* place(key("restart"), replay);
          assert.deepStrictEqual(answer, {
            _tag: "NotStarted",
            threadId: commandId,
            reason: "restarted",
          });
          assert.strictEqual(yield* Ref.get(replay.calls), 0);
        }).pipe(Effect.provide(second));
        yield* Deferred.succeed(held.gate, undefined);
        yield* Scope.close(firstScope, Exit.void);
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          assert.isNull(
            (yield* threads.getThreadShell(ThreadId.make(commandId)))?.latestRunId ?? null,
          );
          const store = yield* Reservations.PlacementReservations;
          assert.strictEqual((yield* store.get(commandId))?.state, "fenced");
        }).pipe(Effect.provide(second));
        yield* Scope.close(secondScope, Exit.void);
      }),
  );
});
