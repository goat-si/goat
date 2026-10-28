import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerSettingsError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { failureCode, fixture, home } from "./OpenCodexChildReady.testkit.ts";

// How setup operations succeed one another on a Child: request history, ownership across a
// crash, journal writes racing a newer operation, probe coalescing and the hydration barrier.
it.layer(NodeServices.layer)("OpenCodexChildReady operations", (it) => {
  it.effect("a new operation probes again after the previous operation's request failed", () =>
    Effect.gen(function* () {
      let first = true;
      const f = yield* fixture({}, (state) => {
        if (first) state.settingsDigest = "changed-mid-request";
        first = false;
      });
      yield* f.routed;
      expect(failureCode(yield* f.call("probe"))).toBe("route_unverified");
      // The same operation never sends a second paid request.
      expect(failureCode(yield* f.call("probe"))).toBe("route_unverified");
      expect(yield* f.probes).toBe(1);
      expect(yield* f.routedAs("op-2")).toBeUndefined();
      expect(yield* f.call("probe", f.state.revision, "op-2")).toMatchObject({
        kind: "ok",
        setup: { readiness: "ready", proof: { operationId: "op-2" } },
      });
      expect(yield* f.probes).toBe(2);
    }),
  );

  it.effect("a proof invalidated later under the same operation needs a new operation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      expect((yield* f.call("probe")).kind).toBe("ok");
      f.state.codexVersion = "0.157.0";
      expect(yield* f.status).toMatchObject({ setup: { readiness: "invalid" } });
      f.state.codexVersion = "0.156.1";
      expect(failureCode(yield* f.call("probe"))).toBe("route_unverified");
      expect(yield* f.probes).toBe(1);
      yield* f.routedAs("op-2");
      expect((yield* f.call("probe", f.state.revision, "op-2")).kind).toBe("ok");
      expect(yield* f.probes).toBe(2);
    }),
  );

  it.effect("adopts an owned instance's committed update after the ownership record was lost", () =>
    Effect.gen(function* () {
      let crashAfterCommit = false;
      const f = yield* fixture({
        commit: (write) =>
          write.pipe(
            Effect.filterOrFail(
              () => !crashAfterCommit,
              () => new ServerSettingsError({ settingsPath: "<test>", operation: "normalize" }),
            ),
          ),
      });
      expect(yield* f.routed).toBeUndefined();
      // OpenCodex moved to another port, so the next operation updates the owned instance.
      f.state.port = 10200;
      crashAfterCommit = true;
      expect((yield* f.call("installCodex", f.state.revision, "op-2")).kind).toBe("ok");
      expect((yield* f.call("syncCatalog", f.state.revision, "op-2")).kind).toBe("ok");
      expect((yield* f.call("configure", f.state.revision, "op-2")).kind).toBe("error");
      expect(yield* f.storedInstance).toMatchObject({
        config: { opencodexBaseUrl: "http://127.0.0.1:10200/v1" },
      });
      crashAfterCommit = false;
      expect((yield* f.call("configure", f.state.revision, "op-2")).kind).toBe("ok");
      expect((yield* f.call("probe", f.state.revision, "op-2")).kind).toBe("ok");
    }),
  );

  it.effect("a status read that finds a broken proof never overwrites a newer operation", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let hold = false;
      const f = yield* fixture({
        duringStatus: () => {
          if (!hold) return Effect.void;
          hold = false;
          return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
        },
      });
      yield* f.routed;
      expect((yield* f.call("probe")).kind).toBe("ok");
      // The status read will find the proof broken, and is held while it reads the facts.
      f.state.codexVersion = "0.157.0";
      hold = true;
      const reading = yield* Effect.forkChild(f.status);
      yield* Deferred.await(entered);
      expect((yield* f.call("installCodex", f.state.revision, "op-2")).kind).toBe("ok");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(reading);
      const stored = yield* f.journal.read(home);
      expect(stored?.operationId).toBe("op-2");
      expect(stored?.setup).toMatchObject({ operationId: "op-2", readiness: "linked" });
    }),
  );

  it.effect("an older operation's late stage and failure never write over a newer operation", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let hold = true;
      const f = yield* fixture({
        commit: (write) => {
          if (!hold) return write;
          hold = false;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(write),
          );
        },
      });
      expect((yield* f.call("installCodex")).kind).toBe("ok");
      expect((yield* f.call("syncCatalog")).kind).toBe("ok");
      const late = yield* Effect.forkChild(f.call("configure"));
      yield* Deferred.await(entered);
      expect((yield* f.call("installCodex", f.state.revision, "op-2")).kind).toBe("ok");
      yield* Deferred.succeed(release, undefined);
      expect(failureCode(yield* Fiber.join(late))).toBe("stale_configuration");
      const stored = yield* f.journal.read(home);
      expect(stored?.operationId).toBe("op-2");
      expect(stored?.setup?.failure).toBeUndefined();
    }),
  );

  it.effect("coalesces concurrent probes of one operation into one model request", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let hold = true;
      const f = yield* fixture({
        duringProbe: () => {
          if (!hold) return Effect.void;
          hold = false;
          return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
        },
      });
      yield* f.routed;
      const first = yield* Effect.forkChild(f.call("probe"));
      yield* Deferred.await(entered);
      const retry = yield* Effect.forkChild(f.call("probe"));
      // Another operation waits its turn instead of sending a second request.
      expect(failureCode(yield* f.call("probe", f.state.revision, "op-2"))).toBe("instance_busy");
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toMatchObject({ kind: "ok", setup: { readiness: "ready" } });
      expect(yield* Fiber.join(retry)).toMatchObject({ kind: "ok", setup: { readiness: "ready" } });
      expect(yield* f.probes).toBe(1);
    }),
  );

  it.effect("configure answers only once the instance hydrated, and no probe runs before", () =>
    Effect.gen(function* () {
      const written = yield* Deferred.make<void>();
      const hydrated = yield* Deferred.make<void>();
      // As the settings service does: the commit lands, then waits for the provider to apply it.
      const f = yield* fixture({
        commit: (write) =>
          write.pipe(
            Effect.tap(() => Deferred.succeed(written, undefined)),
            Effect.tap(() => Deferred.await(hydrated)),
          ),
      });
      expect((yield* f.call("installCodex")).kind).toBe("ok");
      expect((yield* f.call("syncCatalog")).kind).toBe("ok");
      const configuring = yield* Effect.forkChild(f.call("configure"));
      yield* Deferred.await(written);
      expect(failureCode(yield* f.call("probe"))).toBe("route_unverified");
      expect(yield* f.probes).toBe(0);
      yield* Deferred.succeed(hydrated, undefined);
      expect((yield* Fiber.join(configuring)).kind).toBe("ok");
      expect((yield* f.call("probe")).kind).toBe("ok");
      expect(yield* f.probes).toBe(1);
    }),
  );

  it.effect("refuses to probe while the instance's hydration is pending", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      f.state.routeBusy = true;
      expect(failureCode(yield* f.call("probe"))).toBe("instance_busy");
      expect(yield* f.probes).toBe(0);
      f.state.routeBusy = false;
      expect((yield* f.call("probe")).kind).toBe("ok");
    }),
  );

  it.effect(
    "a catalog sync held across a completed probe keeps its proof and request history",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let hold = false;
        const f = yield* fixture({
          duringSync: () => {
            if (!hold) return Effect.void;
            hold = false;
            return Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            );
          },
        });
        yield* f.routed;
        // The same operation's catalog phase may sync again; this one has read its record.
        hold = true;
        const syncing = yield* Effect.forkChild(f.call("syncCatalog"));
        yield* Deferred.await(entered);
        expect(yield* f.call("probe")).toMatchObject({ kind: "ok", setup: { readiness: "ready" } });
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(syncing)).kind).toBe("ok");
        const stored = yield* f.journal.read(home);
        expect(stored?.probeRequestedFor).toBe("op-1");
        expect(stored?.setup?.proof?.operationId).toBe("op-1");
        expect(yield* f.call("probe")).toMatchObject({ kind: "ok", setup: { readiness: "ready" } });
        expect(yield* f.probes).toBe(1);
      }),
  );
});
