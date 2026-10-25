import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import { MaxOpsBeforeYield } from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { IMPLIED_RECHECK_MS } from "./ComputerUseOpenWork.ts";
import { database } from "./ComputerUseLeases.projection.testkit.ts";

// A person's full access run holds foreground without an approval (#1617). These pin that the
// grant ends with its run, and proxies hear of it, when one ordinary thing goes wrong.
const layer = ComputerUseLeases.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(database, NodeServices.layer)),
);

/** `runId` of `threadId` in the projection, at `status`. */
const run = (threadId: ThreadId, runId: string, ordinal: number, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${runId}, ${threadId}, ${ordinal}, 'codex', ${status}, '2026-01-01', '{}')
      ON CONFLICT (run_id) DO UPDATE SET status = excluded.status`;
  });

/** A full access thread whose person run `runId` holds a control and its implied foreground. */
const personRun = Effect.fn("impliedForeground.personRun")(function* (name: string) {
  yield* runMigrations();
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  const sql = yield* SqlClient.SqlClient;
  const threadId = ThreadId.make(`thread-${name}`);
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
       created_at, updated_at, payload_json)
    VALUES (${threadId}, 'project', 'thread', 'codex', 'full-access', 'default',
      '2026-01-01', '2026-01-01', '{}')`;
  yield* run(threadId, `run:${name}:R`, 1, "running");
  const control = Option.getOrThrow(
    yield* leases.everyAppControl(threadId, false, {
      person: true,
      runId: RunId.make(`run:${name}:R`),
    }),
  );
  assert.isTrue(yield* leases.foregroundAvailable(threadId, "Check the build"));
  const signals = yield* leases.subscribe;
  const drain = Effect.gen(function* () {
    if ((yield* PubSub.remaining(signals)) > 0) yield* PubSub.takeAll(signals);
  });
  return { leases, sql, threadId, control, signals, drain };
});

const foregroundIds = (state: ComputerUseLeases.ComputerUseControlState) =>
  state._tag === "active" ? (state.foreground ?? []).map((grant) => grant.handoffId) : [];

it.effect(
  "a run end whose ended-run read fails still revokes the implied foreground and tells proxies",
  () =>
    Effect.gen(function* () {
      const { leases, sql, threadId, signals, drain } = yield* personRun("read-fails");
      yield* run(threadId, "run:read-fails:Q", 2, "queued");
      yield* run(threadId, "run:read-fails:R", 1, "completed");
      yield* drain;
      yield* sql`ALTER TABLE orchestration_v2_projection_runs RENAME TO runs_unavailable`;
      const ended = yield* Effect.exit(leases.turnEnded(threadId));
      yield* sql`ALTER TABLE runs_unavailable RENAME TO orchestration_v2_projection_runs`;
      assert.isTrue(Exit.isFailure(ended));
      // Fail closed: the notice went out from the sweep itself, with no later retry needed.
      assert.isAbove(yield* PubSub.remaining(signals), 0);
      assert.isFalse(yield* leases.foregroundAvailable(threadId, "Check the build"));
      yield* leases.stopAll;
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "a run that ended without its run-end hook loses the implied foreground at the next control check",
  () =>
    Effect.gen(function* () {
      const { leases, threadId, control, signals, drain } = yield* personRun("hook-missed");
      const live = yield* leases.controlState(threadId, control.controlId);
      assert.lengthOf(foregroundIds(live), 1);
      // The lease stream re-checks this soon, so a missed hook cannot leave the grant standing.
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      assert.isAtMost(live._tag === "active" ? live.wakeAt - now : Infinity, IMPLIED_RECHECK_MS);
      yield* run(threadId, "run:hook-missed:R", 1, "completed");
      yield* drain;
      const after = yield* leases.controlState(threadId, control.controlId);
      assert.equal(after._tag, "active");
      assert.deepEqual(foregroundIds(after), []);
      assert.isAbove(yield* PubSub.remaining(signals), 0);
      assert.isFalse(yield* leases.foregroundAvailable(threadId, "Check the build"));
      yield* leases.stopAll;
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "a new run that reuses the control before the old run's end is processed tells proxies the old grant is gone",
  () =>
    Effect.gen(function* () {
      const { leases, threadId, control, signals, drain } = yield* personRun("reused");
      const before = foregroundIds(yield* leases.controlState(threadId, control.controlId));
      yield* run(threadId, "run:reused:Q", 2, "running");
      yield* drain;
      const reused = Option.getOrThrow(
        yield* leases.everyAppControl(threadId, false, {
          person: true,
          runId: RunId.make("run:reused:Q"),
        }),
      );
      assert.equal(reused.controlId, control.controlId);
      // A proxy running R's script sees R's grant leave in this update and cancels the script.
      assert.isAbove(yield* PubSub.remaining(signals), 0);
      const after = foregroundIds(yield* leases.controlState(threadId, control.controlId));
      assert.lengthOf(after, 1);
      assert.notInclude(after, before[0]);
      yield* leases.stopAll;
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

// A control's reuse takes well under this many fiber ops, so the sweep below covers every step.
const YIELD_SWEEP = 160;

it.effect(
  "a Stop that lands at any scheduler yield during a control's reuse is never undone (#1653)",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const sql = yield* SqlClient.SqlClient;
      const outcomes = new Set<string>();
      for (let budget = 8; budget <= YIELD_SWEEP; budget++) {
        const threadId = ThreadId.make(`thread-stop-during-reuse-${budget}`);
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads
            (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
             created_at, updated_at, payload_json)
          VALUES (${threadId}, 'project', 'thread', 'codex', 'full-access', 'default',
            '2026-01-01', '2026-01-01', '{}')`;
        const first = Option.getOrThrow(
          yield* leases.everyAppControl(threadId, false, {
            person: true,
            runId: RunId.make(`run:${budget}:R`),
          }),
        );
        // The reuse yields after `budget` ops, and the Stop forked behind it runs at that yield.
        const reuse = yield* leases
          .everyAppControl(threadId, false, {
            person: true,
            runId: RunId.make(`run:${budget}:Q`),
          })
          .pipe(Effect.provideService(MaxOpsBeforeYield, budget), Effect.forkChild);
        const stop = yield* leases.stop(threadId).pipe(Effect.forkChild);
        const reused = Option.getOrThrow(yield* Fiber.join(reuse));
        assert.isTrue(yield* Fiber.join(stop));
        const state = yield* leases.controlState(threadId, reused.controlId);
        // Either the reuse finished first and the Stop ended it, or the Stop came first and the
        // run got a new control. A reused control that is still live means the Stop was lost.
        if (reused.controlId === first.controlId)
          assert.deepEqual(state, { _tag: "ended", reason: "stopped" });
        outcomes.add(reused.controlId === first.controlId ? "reused" : "new");
      }
      // The sweep reached both orders, so it crossed the whole reuse.
      assert.deepEqual([...outcomes].sort(), ["new", "reused"]);
      yield* leases.stopAll;
    }).pipe(Effect.provide(layer)),
);
