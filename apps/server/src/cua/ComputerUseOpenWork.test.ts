import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { database } from "./ComputerUseLeases.projection.testkit.ts";
import { makeRunEnd, threadOpenWork } from "./ComputerUseOpenWork.ts";

it.effect(
  "an interrupt that lands while an ended run's foreground is revoked still lets the revocation publish (#1617)",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-open-work-interrupted");
      const runId = RunId.make("run:ended");
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${runId}, ${threadId}, 1, 'codex', 'completed', '2026-01-01', '{}')`;
      let implied: ReadonlyArray<RunId> = [runId];
      let published = 0;
      const fiber = yield* Effect.gen(function* () {
        const self = yield* Effect.fiber;
        return yield* threadOpenWork(
          sql,
          {
            impliedRuns: () => implied,
            revokeRun: (_thread, ended) => {
              implied = implied.filter((id) => id !== ended);
              // Stop or shutdown interrupts the sweep right after the foreground is gone.
              self.interruptUnsafe();
            },
          },
          threadId,
          Effect.sync(() => {
            published++;
          }),
        );
      }).pipe(Effect.forkChild({ startImmediately: true }));
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.hasInterrupts(exit));
      assert.deepEqual(implied, []);
      // A retry finds nothing left to revoke, so this was the only chance to tell proxies.
      assert.equal(published, 1);
    }).pipe(Effect.provide(database)),
);

it.effect(
  "an interrupt that lands while the ended-run read is under way still revokes and publishes (#1617)",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-open-work-read-interrupted");
      const runId = RunId.make("run:read-interrupted");
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${runId}, ${threadId}, 1, 'codex', 'completed', '2026-01-01', '{}')`;
      let implied: ReadonlyArray<RunId> = [runId];
      let published = 0;
      const fiber = yield* Effect.gen(function* () {
        const self = yield* Effect.fiber;
        return yield* threadOpenWork(
          sql,
          {
            impliedRuns: () => {
              // The sweep is interrupted as it starts reading which runs ended.
              self.interruptUnsafe();
              return implied;
            },
            revokeRun: (_thread, ended) => {
              implied = implied.filter((id) => id !== ended);
            },
          },
          threadId,
          Effect.sync(() => {
            published++;
          }),
        );
      }).pipe(Effect.forkChild({ startImmediately: true }));
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(fiber)));
      assert.deepEqual(implied, []);
      assert.equal(published, 1);
    }).pipe(Effect.provide(database)),
);

it.effect(
  "a turn that reuses a waiting-idled control while its last run's end is read keeps its approvals and stays acting",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-open-work-reused");
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // The thread's last run ended; the read answers only once the test releases it.
      const sql = ((..._: ReadonlyArray<unknown>) =>
        Deferred.succeed(reading, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as([]),
        )) as unknown as SqlClient.SqlClient;
      const revoked: Array<string> = [];
      const controls = new Map([
        [threadId, { controlId: "control:1", uses: 0, idle: true, idleEpoch: 1, waitHeld: true }],
      ]);
      const { turnEnded } = makeRunEnd({
        sql,
        foreground: {
          impliedRuns: () => [],
          revokeRun: () => undefined,
          revokeControl: (_thread, controlId) => void revoked.push(controlId),
        },
        controls,
        changed: Effect.void,
        idled: () => undefined,
        error: (cause) => cause,
      });
      const settling = yield* turnEnded(threadId).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(reading);
      // A new turn of the thread takes the same control up while the read is out.
      controls.set(threadId, {
        controlId: "control:1",
        uses: 1,
        idle: false,
        idleEpoch: 1,
        waitHeld: true,
      });
      yield* Deferred.succeed(release, undefined);
      assert.isFalse(yield* Fiber.join(settling));
      assert.deepEqual(revoked, []);
      assert.isFalse(controls.get(threadId)?.idle);
    }),
);
