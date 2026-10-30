import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { foregroundProxy, foregroundProxyLayer } from "./ComputerUseForeground.testkit.ts";
import { call } from "./ComputerUseLeaseProxy.testkit.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";

/** A run of `threadId` in the projection, at `status`. */
const run = (threadId: ThreadId, runId: string, ordinal: number, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${runId}, ${threadId}, ${ordinal}, 'codex', ${status}, '2026-01-01', '{}')`;
  });

it.effect(
  "a thread whose only open run waits stops its driver at the turn's end, and its next turn starts one with its approvals",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const thread = ThreadId.make("thread:waiting-run");
      const { h, leases, control, admission } = yield* foregroundProxy(thread);
      const first = yield* h.driverStarted;
      // Waiting on a person or a child: no provider turn can call the driver until the next one.
      yield* run(thread, "run:waiting", 1, "waiting");
      assert.isTrue(yield* leases.turnEnded(thread));
      yield* h.killed;

      const reused = yield* leases.control(thread, Option.some(admission));
      assert.equal(reused.controlId, control.controlId);
      const next = yield* h.driverStarted;
      assert.equal(next.generation, first.generation + 1);
      // The waiting run still owns the person's foreground approval, so the call goes out.
      yield* h.send(
        call(1, "type_text", {
          pid: 42,
          window_id: 7,
          text: "next turn",
          delivery_mode: "foreground",
        }),
      );
      assert.equal((yield* h.nextDispatch).message.id, 1);
    }).pipe(Effect.provide(foregroundProxyLayer)),
);

it.effect.each([
  ["a provider turn of the thread is running", "turn"],
  ["a native subagent waits", "native"],
  ["another run is queued", "queued"],
] as const)("a waiting run keeps its control acting while %s", ([, open]) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const sql = yield* SqlClient.SqlClient;
    const thread = ThreadId.make(`thread:waiting-${open}`);
    const control = yield* leases.control(thread, Option.none());
    yield* run(thread, `run:waiting-${open}`, 1, "waiting");
    if (open === "turn")
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_turns
          (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, payload_json)
        VALUES ('turn:waiting', ${thread}, 'provider-thread', 'node', 1, 'running', '{}')`;
    else if (open === "native")
      yield* sql`
        INSERT INTO orchestration_v2_projection_subagents
          (subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json)
        VALUES ('sub:waiting', ${thread}, 'node', 'codex', 'thread:waiting-native-child', 'provider_native', 'waiting', '2026-10-24', '{}')`;
    else yield* run(thread, `run:queued-${open}`, 2, "queued");
    assert.isFalse(yield* leases.turnEnded(thread));
    const listed = (yield* leases.sessions).find(
      (entry) => entry.control.controlId === control.controlId,
    );
    assert.isUndefined(listed?.control.idle);
  }).pipe(Effect.provide(foregroundProxyLayer)),
);
