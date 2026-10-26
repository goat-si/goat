import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { threadRouteFixture } from "./ComputerUseLeaseRoute.thread.testkit.ts";

describe("recoverable thread lease subscriptions", () => {
  it.effect(
    "disable ends the active control, waits on the open stream, and follows a new control after re-enable",
    () =>
      Effect.gen(function* () {
        const f = yield* threadRouteFixture();
        const a = yield* f.attach();
        const s = yield* f.open();
        assert.deepInclude(yield* s.next, {
          state: "active",
          controlId: a.attachment.control.controlId,
        });
        yield* f.disable;
        assert.deepEqual(yield* s.next, {
          state: "control-ended",
          controlId: a.attachment.control.controlId,
          reason: "disabled",
        });
        assert.deepEqual(yield* s.next, { state: "waiting" });
        yield* f.enable;
        const b = yield* f.attach();
        assert.notEqual(b.attachment.control.controlId, a.attachment.control.controlId);
        assert.deepInclude(yield* s.next, {
          state: "active",
          controlId: b.attachment.control.controlId,
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a disabled subscription without a control waits and follows its first new control",
    () =>
      Effect.gen(function* () {
        const f = yield* threadRouteFixture();
        yield* f.disable;
        const s = yield* f.open();
        assert.deepEqual(yield* s.next, { state: "waiting" });
        yield* f.enable;
        const a = yield* f.attach();
        assert.deepInclude(yield* s.next, {
          state: "active",
          controlId: a.attachment.control.controlId,
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a failed control-state read ends that control as revoked and a new control recovers",
    () =>
      Effect.gen(function* () {
        const f = yield* threadRouteFixture();
        const a = yield* f.attach();
        const s = yield* f.open();
        yield* s.next;
        yield* f.failControlRead;
        assert.deepEqual(yield* s.next, {
          state: "control-ended",
          controlId: a.attachment.control.controlId,
          reason: "revoked",
        });
        assert.deepEqual(yield* s.next, { state: "waiting" });
        yield* f.restoreControlRead;
        yield* f.leases.stop(f.threadId);
        const b = yield* f.attach();
        assert.notEqual(b.attachment.control.controlId, a.attachment.control.controlId);
        assert.deepInclude(yield* s.next, {
          state: "active",
          controlId: b.attachment.control.controlId,
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "credential revocation remains terminal while disabled and cannot follow a later control",
    () =>
      Effect.gen(function* () {
        const f = yield* threadRouteFixture();
        yield* f.disable;
        const s = yield* f.open();
        assert.deepEqual(yield* s.next, { state: "waiting" });
        yield* f.registry.revokeThread(f.threadId);
        assert.deepEqual(yield* s.next, { state: "ended", reason: "unauthorized" });
        yield* f.enable;
        yield* f.attach();
        assert.isUndefined(yield* s.next);
      }).pipe(Effect.scoped),
  );
});
