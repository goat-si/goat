import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { database } from "./ComputerUseLeases.projection.testkit.ts";
import { threadOpenWork } from "./ComputerUseOpenWork.ts";

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
