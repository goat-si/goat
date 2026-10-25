import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, TurnItemId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import {
  controlWithForeground,
  foregroundGrant,
  foregroundServiceLayer,
  revokeForegroundGrant,
} from "./ComputerUseForeground.testkit.ts";

const thread = ThreadId.make("thread:foreground");
const other = ThreadId.make("thread:other");
const reserve = (
  leases: ComputerUseLeases.ComputerUseLeases["Service"],
  controlId: string,
  grantId: TurnItemId,
  owner = thread,
) =>
  leases.callReservation(owner, {
    action: "reserve",
    controlId,
    connectionId: "driver:focus",
    callId: "focus",
    interruptions: 0,
    idleEpoch: 0,
    name: "bring_to_front",
    args: { pid: 42, window_id: 7 },
    foregroundGrantId: grantId,
  });

describe("foreground approval authority", () => {
  it.effect(
    "turn end irrevocably revokes bound foreground authority while the reused control admits background",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const background = yield* foregroundGrant(thread, "handoff:turn-background", {
          foreground: false,
          minutes: 60,
          apps: ["com.example.Build"],
        });
        const admission = yield* leases.state(thread, background.handoffId);
        if (admission._tag !== "active") return assert.fail("expected background admission");
        const control = yield* leases.control(thread, Option.some(admission.lease));
        const grant = yield* foregroundGrant(thread, "handoff:turn-foreground");
        assert.isTrue(yield* leases.foregroundAvailable(thread, "Check the build status"));
        assert.isTrue(yield* leases.turnEnded(thread));
        assert.isFalse(yield* leases.turnEnded(thread));
        const resumed = yield* leases.control(thread, Option.some(admission.lease));
        assert.equal(resumed.controlId, control.controlId);
        assert.isFalse(yield* leases.foregroundAvailable(thread, "Check the build status"));
        yield* leases.approveForeground(grant, yield* leases.foregroundApprovalEpoch);
        const state = yield* leases.controlState(thread, resumed.controlId);
        if (state._tag !== "active") return assert.fail("expected reused background control");
        assert.isUndefined(state.foreground);
        assert.deepEqual(state.apps, ["com.example.Build"]);
        const request = {
          action: "reserve" as const,
          controlId: resumed.controlId,
          connectionId: "driver:turn-reuse",
          callId: "type",
          interruptions: state.interruptions.count,
          idleEpoch: state.idleEpoch ?? 0,
          name: "type_text",
          args: { pid: 42, window_id: 7, text: "work", delivery_mode: "foreground" },
        };
        assert.deepEqual(
          yield* leases.callReservation(thread, { ...request, foregroundGrantId: grant.handoffId }),
          { status: "refused", detail: "foreground_not_approved" },
        );
        const admitted = yield* leases.callReservation(thread, {
          ...request,
          args: { pid: 42, window_id: 7, text: "background" },
        });
        assert.equal(admitted.status, "admitted");
      }).pipe(Effect.provide(foregroundServiceLayer)),
  );

  it.effect("turn end preserves a new approval pending its own next control", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const background = yield* foregroundGrant(thread, "handoff:pending-background", {
        foreground: false,
        minutes: 10,
      });
      const admission = yield* leases.state(thread, background.handoffId);
      if (admission._tag !== "active") return assert.fail("expected background admission");
      const control = yield* leases.control(thread, Option.some(admission.lease));
      const old = yield* foregroundGrant(thread, "handoff:pending-old", { minutes: 5 });
      const pending = yield* foregroundGrant(thread, "handoff:pending-new");
      assert.isTrue(yield* leases.turnEnded(thread));
      yield* leases.approveForeground(old, yield* leases.foregroundApprovalEpoch);
      const nextAdmission = yield* leases.state(thread, pending.handoffId);
      if (nextAdmission._tag !== "active") return assert.fail("expected next admission");
      const next = yield* leases.control(thread, Option.some(nextAdmission.lease));
      assert.notEqual(next.controlId, control.controlId);
      const state = yield* leases.controlState(thread, next.controlId);
      if (state._tag !== "active") return assert.fail("expected next control");
      assert.deepEqual(
        state.foreground?.map((grant) => grant.handoffId),
        [pending.handoffId],
      );
      assert.deepEqual(yield* reserve(leases, next.controlId, old.handoffId), {
        status: "refused",
        detail: "foreground_not_approved",
      });
      assert.equal((yield* reserve(leases, next.controlId, pending.handoffId)).status, "admitted");
    }).pipe(Effect.provide(foregroundServiceLayer)),
  );

  it.effect("a queued next turn keeps the current control's foreground authority", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const { leases, control } = yield* controlWithForeground(thread);
      const grant = yield* foregroundGrant(thread, "handoff:open-work");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('run:next', ${thread}, 1, 'codex', 'queued', '2026-01-01', '{}')`;
      assert.isFalse(yield* leases.turnEnded(thread));
      assert.isTrue(yield* leases.foregroundAvailable(thread, "Check the build status"));
      assert.equal((yield* reserve(leases, control.controlId, grant.handoffId)).status, "admitted");
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run:next'`;
      assert.isTrue(yield* leases.turnEnded(thread));
      assert.isFalse(yield* leases.foregroundAvailable(thread, "Check the build status"));
    }).pipe(Effect.provide(foregroundServiceLayer)),
  );

  it.effect("does not derive foreground authority from persisted admission metadata", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const { leases, control } = yield* controlWithForeground(thread);
      const grant = yield* foregroundGrant(thread, "handoff:metadata", { approve: false });
      assert.deepEqual(yield* reserve(leases, control.controlId, grant.handoffId), {
        status: "refused",
        detail: "foreground_not_approved",
      });
      assert.isFalse(yield* leases.foregroundAvailable(thread, "Check the build status"));
    }).pipe(Effect.provide(foregroundServiceLayer)),
  );

  it.effect(
    "binds approved purpose, desktop target, control and expiry without granting another thread",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const { leases, control } = yield* controlWithForeground(thread);
        const grant = yield* foregroundGrant(thread, "handoff:focus");
        assert.isTrue(yield* leases.foregroundAvailable(thread, "Check the build status"));
        assert.isFalse(yield* leases.foregroundAvailable(thread, "Send a message"));
        assert.equal(
          (yield* reserve(leases, control.controlId, grant.handoffId)).status,
          "admitted",
        );
        const second = yield* leases.control(other, Option.none());
        assert.deepEqual(yield* reserve(leases, second.controlId, grant.handoffId, other), {
          status: "refused",
          detail: "foreground_not_approved",
        });
        assert.deepEqual(
          yield* reserve(leases, second.controlId, TurnItemId.make("handoff:forged"), other),
          {
            status: "refused",
            detail: "foreground_not_approved",
          },
        );
      }).pipe(Effect.provide(foregroundServiceLayer)),
  );

  it.effect("binds only the matching admission handoff on an ordinary unattended next mint", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const a = yield* foregroundGrant(thread, "handoff:first", { purpose: "First task" });
      const b = yield* foregroundGrant(thread, "handoff:second", { purpose: "Second task" });
      const state = yield* leases.state(thread, b.handoffId);
      if (state._tag !== "active") return assert.fail("expected completed admission");
      const control = yield* leases.control(thread, Option.some(state.lease));
      const current = yield* leases.controlState(thread, control.controlId);
      if (current._tag !== "active") return assert.fail("expected live control");
      assert.deepEqual(
        current.foreground?.map((grant) => grant.handoffId),
        [b.handoffId],
      );
      assert.isFalse(yield* leases.foregroundAvailable(thread, "First task"));
      assert.deepEqual(yield* reserve(leases, control.controlId, a.handoffId), {
        status: "refused",
        detail: "foreground_not_approved",
      });
    }).pipe(Effect.provide(foregroundServiceLayer)),
  );

  it.effect.each(["stop", "pause", "stopAll", "disable"] as const)(
    "invalidates an approval racing %s even before any control exists",
    (action) =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const epoch = yield* leases.foregroundApprovalEpoch;
        if (action === "stop") yield* leases.stop(thread);
        else if (action === "pause") yield* leases.pause("takeover");
        else yield* leases[action];
        const grant = yield* foregroundGrant(thread, "handoff:pending", { observedEpoch: epoch });
        const control = yield* leases.control(thread, Option.none());
        assert.deepEqual(yield* reserve(leases, control.controlId, grant.handoffId), {
          status: "refused",
          detail: "foreground_not_approved",
        });
        yield* leases.approveForeground(grant, yield* leases.foregroundApprovalEpoch);
        assert.isFalse(yield* leases.foregroundAvailable(thread, "Check the build status"));
      }).pipe(Effect.provide(foregroundServiceLayer)),
  );

  it.effect(
    "pause and handback never resurrect an approval, including a repeated completed response",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const { leases, control } = yield* controlWithForeground(thread);
        const grant = yield* foregroundGrant(thread, "handoff:paused");
        yield* leases.pause("takeover");
        yield* leases.resume;
        yield* leases.approveForeground(grant, yield* leases.foregroundApprovalEpoch);
        const state = yield* leases.controlState(thread, control.controlId);
        assert.equal(state._tag, "active");
        assert.isUndefined(state._tag === "active" ? state.foreground : "ended");
        assert.isFalse(yield* leases.foregroundAvailable(thread, "Check the build status"));
      }).pipe(Effect.provide(foregroundServiceLayer)),
  );

  it.effect(
    "stop, replacement and a new lease service cannot reuse an older foreground approval",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const { leases, control } = yield* controlWithForeground(thread);
        const grant = yield* foregroundGrant(thread, "handoff:old");
        const admission = yield* leases.state(thread, grant.handoffId);
        if (admission._tag !== "active") return assert.fail("expected live admission");
        const replaced = yield* leases.control(thread, Option.some(admission.lease));
        assert.notEqual(control.controlId, replaced.controlId);
        assert.isFalse(yield* leases.foregroundAvailable(thread, "Check the build status"));
        yield* leases.stop(thread);
        yield* leases.control(thread, Option.none());
        assert.isFalse(yield* leases.foregroundAvailable(thread, "Check the build status"));
        yield* Effect.gen(function* () {
          const restarted = yield* ComputerUseLeases.ComputerUseLeases;
          const next = yield* restarted.control(thread, Option.none());
          assert.deepEqual(yield* reserve(restarted, next.controlId, grant.handoffId), {
            status: "refused",
            detail: "foreground_not_approved",
          });
        }).pipe(
          Effect.provide(
            Layer.fresh(ComputerUseLeases.layer).pipe(Layer.provide(NodeServices.layer)),
          ),
        );
      }).pipe(Effect.provide(foregroundServiceLayer)),
  );

  it.effect(
    "foreground expiry and cancellation revoke focus while background admission continues",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const { leases, control } = yield* controlWithForeground(thread);
        yield* foregroundGrant(thread, "handoff:background", { foreground: false, minutes: 60 });
        const grant = yield* foregroundGrant(thread, "handoff:short", { minutes: 5 });
        const active = yield* leases.controlState(thread, control.controlId);
        assert.equal(active._tag === "active" ? active.wakeAt : 0, 300_000);
        yield* TestClock.adjust("5 minutes");
        assert.deepEqual(yield* reserve(leases, control.controlId, grant.handoffId), {
          status: "refused",
          detail: "foreground_not_approved",
        });
        const longer = yield* foregroundGrant(thread, "handoff:cancelled");
        yield* revokeForegroundGrant(longer.handoffId);
        assert.deepEqual(yield* reserve(leases, control.controlId, longer.handoffId), {
          status: "refused",
          detail: "foreground_not_approved",
        });
        const state = yield* leases.controlState(thread, control.controlId);
        assert.equal(state._tag, "active");
        assert.isUndefined(state._tag === "active" ? state.apps : "ended");
      }).pipe(Effect.provide(foregroundServiceLayer)),
  );
});
