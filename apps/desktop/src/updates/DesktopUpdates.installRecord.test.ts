import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

it.effect("flags an install that did not apply and keeps the flag through checks", () => {
  const harness = makeHarness({
    installRecord: JSON.stringify({ fromVersion: "1.2.3", targetVersion: "1.2.4" }),
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      assert.equal((yield* updates.getState).notAppliedVersion, "1.2.4");
      yield* updates.confirmWorkspaceReady;
      assert.isDefined(harness.previousInstallRecord());

      harness.emit("update-available", { version: "1.2.4" });
      yield* flushCallbacks;
      const state = yield* updates.getState;
      assert.equal(state.status, "available");
      assert.equal(state.notAppliedVersion, "1.2.4");
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
});

// regression: #19291 an install that did apply was still flagged as not applied
it.effect("keeps the launched target on disk until its workspace commits", () => {
  const harness = makeHarness({
    installRecord: JSON.stringify({ fromVersion: "1.2.2", targetVersion: "1.2.3" }),
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      assert.isUndefined((yield* updates.getState).notAppliedVersion);
      assert.deepEqual(
        [...harness.installRecords.values()].map((record) => JSON.parse(record)),
        [
          {
            fromVersion: "1.2.2",
            targetVersion: "1.2.3",
            phase: "awaiting-workspace",
          },
        ],
      );
      yield* updates.confirmWorkspaceReady;
      yield* updates.confirmWorkspaceReady;
      assert.isUndefined(harness.previousInstallRecord());
      assert.equal(harness.installRecords.size, 0);
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
});

it.effect("can confirm after a renderer failed on an earlier launch of the target", () => {
  const harness = makeHarness({
    installRecord: JSON.stringify({
      fromVersion: "1.2.2",
      targetVersion: "1.2.3",
      phase: "awaiting-workspace",
    }),
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      assert.isDefined(harness.previousInstallRecord());
      yield* updates.confirmWorkspaceReady;
      assert.isUndefined(harness.previousInstallRecord());
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
});

it.effect("configuration after an early confirmation cannot recreate a completed record", () => {
  const harness = makeHarness({
    installRecord: JSON.stringify({ fromVersion: "1.2.2", targetVersion: "1.2.3" }),
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.confirmWorkspaceReady;
      yield* updates.configure;
      assert.isUndefined(harness.previousInstallRecord());
      assert.equal(harness.installRecords.size, 0);
      assert.isUndefined((yield* updates.getState).notAppliedVersion);
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
});

it.effect("an unrelated build leaves another target's awaiting-workspace record intact", () => {
  const record = JSON.stringify({
    fromVersion: "1.2.1",
    targetVersion: "1.2.2",
    phase: "awaiting-workspace",
  });
  const harness = makeHarness({ installRecord: record });
  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* updates.confirmWorkspaceReady;
      assert.equal(harness.previousInstallRecord(), record);
      assert.isUndefined((yield* updates.getState).notAppliedVersion);
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
});

it.effect("discards a corrupt install record during configuration", () => {
  const harness = makeHarness({ installRecord: "{" });
  return Effect.scoped(
    Effect.gen(function* () {
      yield* (yield* DesktopUpdates.DesktopUpdates).configure;
      assert.isUndefined(harness.previousInstallRecord());
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
});

it.effect("a late workspace confirmation preserves a newer install attempt", () => {
  const harness = makeHarness({
    installRecord: JSON.stringify({ fromVersion: "1.2.2", targetVersion: "1.2.3" }),
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      assert.isTrue((yield* updates.install).accepted);
      yield* updates.confirmWorkspaceReady;
      assert.deepEqual(
        [...harness.installRecords.values()].map((record) => JSON.parse(record)),
        [
          {
            fromVersion: "1.2.3",
            targetVersion: "1.2.4",
          },
        ],
      );
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
});
