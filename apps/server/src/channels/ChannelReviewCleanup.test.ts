import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

it.effect(
  "cleanup selects at most twenty due owners and retains deferred identities across restart",
  () =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const now = "2026-10-12T00:00:00.000Z";
      const later = "2026-10-12T00:05:00.000Z";
      yield* ledger.claimOwnership({ token: "cleanup-owner", now, staleBefore: now });
      const entries = Array.from({ length: 25 }, (_, i) => ({
        taskId: "removed-task",
        generation: 1,
        workerRunId: "worker-run",
        projectId: "project",
        threadId: "review-" + String(i).padStart(2, "0"),
        runtimeMode: "approval-required",
        createdAt: now,
        nextAttemptAt: now,
        attempts: 0,
        done: false,
        readKey: "synthetic-retained-capability",
      }));
      for (const entry of entries)
        yield* ledger.reserveReviewDispatch({
          owner: "cleanup-owner",
          key: "cleanup:" + entry.threadId,
          value: JSON.stringify(entry),
          now,
        });
      assert.lengthOf(yield* ledger.listReviewCleanup(now), 20);
      for (const entry of entries.slice(0, 20))
        yield* ledger.updateReviewCleanup({
          owner: "cleanup-owner",
          key: entry.threadId,
          value: JSON.stringify({ ...entry, attempts: 9, nextAttemptAt: later }),
          now,
        });
      const restarted = yield* ChannelLedger.ChannelLedger.pipe(
        Effect.provide(Layer.fresh(ChannelLedger.layer)),
      );
      assert.lengthOf(yield* restarted.listReviewCleanup(now), 5);
      assert.lengthOf(yield* restarted.listReviewCleanup(later), 20);
      const sql = yield* SqlClient.SqlClient;
      const retained = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM channel_runtime_state
      WHERE key LIKE 'review:cleanup:%' AND json_extract(value_json, '$.readKey') = 'synthetic-retained-capability'`;
      assert.deepStrictEqual(retained, [{ count: 25 }]);
    }).pipe(
      Effect.provide(ChannelLedger.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);

it.effect(
  "a remote dispatch and cleanup capability reserve atomically and cannot be relaunched after payload expiry",
  () =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const now = "2026-10-12T00:00:00.000Z";
      yield* ledger.claimOwnership({ token: "cleanup-owner", now, staleBefore: now });
      const reserve = {
        owner: "cleanup-owner",
        key: "remote-reservation",
        value: '{"readKey":"private-key"}',
        now,
        cleanup: { key: "review-thread", value: '{"readKey":"private-key","done":false}' },
      };
      assert.isTrue(yield* ledger.reserveReviewDispatch(reserve));
      assert.strictEqual(
        yield* ledger.getReviewDispatch("cleanup:review-thread"),
        reserve.cleanup.value,
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM channel_runtime_state WHERE key = 'review:remote-reservation'`;
      const restarted = yield* ChannelLedger.ChannelLedger.pipe(
        Effect.provide(Layer.fresh(ChannelLedger.layer)),
      );
      assert.isFalse(yield* restarted.reserveReviewDispatch(reserve));
      assert.isUndefined(yield* ledger.getReviewDispatch("remote-reservation"));
      assert.strictEqual(
        yield* ledger.getReviewDispatch("cleanup:review-thread"),
        reserve.cleanup.value,
      );
    }).pipe(
      Effect.provide(ChannelLedger.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);
