import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type DesktopCuaReadinessReport, ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const layer = it.layer(
  Layer.merge(
    database,
    ComputerUseLeases.layer.pipe(Layer.provide(Layer.merge(database, NodeServices.layer))),
  ),
);

layer("ComputerUseLeases blocked turns", (it) => {
  it.effect(
    "lists a turn the desktop blocked while it runs, until a driver starts for it or the turn ends (#1399)",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const block = {
          reason: "permissionsNotGranted",
          missing: ["screenRecording"],
          holder: "helper",
        } as const;
        const sql = yield* SqlClient.SqlClient;
        const blocked = ThreadId.make("thread-blocked");
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs
            (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES ('run-blocked-1', ${blocked}, 1, 'codex', 'running', '2026-01-01', '{}')
        `;
        yield* leases.blocked(blocked, block);
        assert.deepEqual(yield* leases.blockedTurns, [{ threadId: blocked, block }]);
        // Still running: the turn stays listed.
        yield* leases.settle;
        assert.lengthOf(yield* leases.blockedTurns, 1);
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-blocked-1'`;
        yield* leases.settle;
        assert.deepEqual(yield* leases.blockedTurns, []);

        // A later turn that gets a driver is no longer blocked.
        const granted = ThreadId.make("thread-granted");
        yield* leases.blocked(granted, block);
        yield* leases.control(granted, Option.none());
        assert.deepEqual(yield* leases.blockedTurns, []);
      }),
  );

  it.effect("wakes the session list whenever a blocked turn is listed or cleared (#1399)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const block = {
          reason: "permissionsNotGranted",
          missing: ["accessibility"],
          holder: "helper",
        } as const;
        const subscription = yield* leases.subscribe;
        const woke = Effect.gen(function* () {
          const count = yield* PubSub.remaining(subscription);
          if (count > 0) yield* PubSub.takeAll(subscription);
          return count > 0;
        });
        const first = ThreadId.make("thread-blocked-first");
        yield* leases.blocked(first, block);
        assert.isTrue(yield* woke);
        // Its first control clears it.
        yield* leases.control(first, Option.none());
        assert.isTrue(yield* woke);
        yield* leases.stop(first);
        yield* woke;
        // Turning computer use off with only a blocked turn listed clears it too.
        yield* leases.blocked(ThreadId.make("thread-blocked-off"), block);
        yield* woke;
        yield* leases.disable;
        assert.isTrue(yield* woke);
        assert.deepEqual(yield* leases.blockedTurns, []);
      }),
    ),
  );
});

it.effect("a blocked turn names only the grants still missing, and leaves once all return", () =>
  Effect.gen(function* () {
    const accepted = yield* Ref.make(Option.none<DesktopCuaReadinessReport>());
    const report = (
      accessibility: "granted" | "denied",
      screenCapture: "granted" | "denied",
    ): DesktopCuaReadinessReport => ({
      version: 1,
      type: "cuaReadiness",
      generation: 1,
      readiness: {
        grants: { accessibility, screenCapture },
        helper: "authenticated",
        capture: "pending",
        tree: "unavailable",
        input: "unavailable",
        blockers: [],
        reasons: [],
      },
      signals: { privateMode: "unsupported", humanInput: "unsupported" },
    });
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const thread = ThreadId.make("thread-blocked-grants");
      const block = {
        reason: "permissionsNotGranted",
        missing: ["accessibility", "screenRecording"],
        holder: "helper",
      } as const;
      yield* Ref.set(accepted, Option.some(report("denied", "denied")));
      yield* leases.blocked(thread, block);
      assert.deepEqual(yield* leases.blockedTurns, [{ threadId: thread, block }]);
      yield* Ref.set(accepted, Option.some(report("granted", "denied")));
      assert.deepEqual(yield* leases.blockedTurns, [
        { threadId: thread, block: { ...block, missing: ["screenRecording"] } },
      ]);
      // Every grant is back while the turn still runs: the preview has nothing to show.
      yield* Ref.set(accepted, Option.some(report("granted", "granted")));
      assert.deepEqual(yield* leases.blockedTurns, []);
    }).pipe(
      Effect.provide(
        ComputerUseLeases.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              database,
              NodeServices.layer,
              DesktopTelemetryReceiver.layerTest({ cuaReadiness: Ref.get(accepted) }),
            ),
          ),
        ),
      ),
    );
  }),
);
