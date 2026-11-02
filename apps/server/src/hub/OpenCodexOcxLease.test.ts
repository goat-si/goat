import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { HubOcx } from "./HubOcx.ts";
import { layer as syncLayer, OpenCodexSync } from "./OpenCodexSync.ts";
import { OpenCodexUpdateHost } from "./OpenCodexUpdateHost.ts";
import { makeFleet, MINUTE, setup, type Fleet } from "./OpenCodexManagedUpdate.testkit.ts";
import { fleetSnapshot } from "./parity.testkit.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("lease-test"),
  requestNamespace: "lease-test",
  thread: undefined,
  client: { sessionId: "lease-test", label: "test", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const scriptedOcx = Effect.fn("OpenCodexOcxLeaseTest.scriptedOcx")(function* (fleet: Fleet) {
  const testScope = yield* Effect.scope;
  const lease = yield* Ref.make<"sync" | "update" | undefined>(undefined);
  const syncStarted = yield* Deferred.make<void>();
  const syncRelease = yield* Deferred.make<void>();
  const updateStarted = yield* Deferred.make<void>();
  const updateRelease = yield* Deferred.make<void>();
  const updateEnded = yield* Deferred.make<void>();
  const script = {
    holdSync: false,
    holdUpdate: false,
    loseApplyReply: false,
    refusal: "",
    syncExit: -1,
    applyExit: -1,
    mutations: 0,
  };
  const acquire = (kind: "sync" | "update") =>
    Ref.modify(lease, (held) =>
      held === undefined ? ([true, kind] as const) : ([false, held] as const),
    );
  const endUpdate = Ref.set(lease, undefined).pipe(
    Effect.andThen(
      Effect.sync(() => {
        fleet.inFlight = false;
      }),
    ),
    Effect.andThen(Deferred.succeed(updateEnded, undefined)),
    Effect.asVoid,
  );
  const home = Effect.fn("OpenCodexOcxLeaseTest.home")(function* (args: ReadonlyArray<string>) {
    if (args[0] === "capabilities")
      return { code: 0, stdout: '{"contracts":["update.orchestrated/1","sync.home-fanout/1"]}' };
    if (!(yield* acquire("sync"))) {
      script.syncExit = 7;
      return { code: 7, stdout: "update-in-flight" };
    }
    return yield* Effect.gen(function* () {
      yield* Deferred.succeed(syncStarted, undefined);
      if (script.holdSync) yield* Deferred.await(syncRelease);
      script.syncExit = 0;
      return { code: 0, stdout: "" };
    }).pipe(Effect.ensuring(Ref.set(lease, undefined)));
  });
  fleet.applyOverride = Effect.fn("OpenCodexOcxLeaseTest.apply")(
    function* (alias, version, token, notAfter) {
      if (!(yield* acquire("update"))) {
        script.applyExit = 10;
        script.refusal = "sync-in-progress";
        return "refused" as const;
      }
      fleet.inFlight = true;
      yield* Deferred.succeed(updateStarted, undefined);
      if (script.loseApplyReply) {
        yield* Deferred.await(updateRelease).pipe(
          Effect.ensuring(endUpdate),
          Effect.forkIn(testScope),
        );
        return "uncertain" as const;
      }
      return yield* Effect.gen(function* () {
        if (script.holdUpdate) yield* Deferred.await(updateRelease);
        if ((yield* Clock.currentTimeMillis) > notAfter) {
          script.applyExit = 10;
          script.refusal = "deadline-passed";
          return "refused" as const;
        }
        if (token !== fleet.planToken) {
          script.applyExit = 10;
          script.refusal = "plan-changed";
          return "refused" as const;
        }
        script.applyExit = 0;
        script.mutations++;
        fleet.versions.set(alias, version);
        fleet.processId.set(alias, (fleet.processId.get(alias) ?? 0) + 1);
        fleet.startedAt.set(alias, (fleet.startedAt.get(alias) ?? 0) + MINUTE);
        return "applied" as const;
      }).pipe(Effect.ensuring(endUpdate));
    },
  );
  const snapshot = fleetSnapshot("home");
  const context = yield* Layer.build(
    syncLayer.pipe(
      Layer.provide(
        Layer.mock(OpenCodexUpdateHost)({
          member: (alias) =>
            Effect.succeed({
              alias,
              runningTurns: 0,
              snapshot: { ...snapshot, link: { ...snapshot.link, links: [] } },
            }),
          holdAdmission: () => Effect.succeed(true),
          releaseAdmission: () => Effect.void,
        }),
      ),
      Layer.provide(Layer.mock(HubOcx)({ home })),
    ),
  );
  const sync = yield* OpenCodexSync.pipe(Effect.provideContext(context));
  return { sync, script, syncStarted, syncRelease, updateStarted, updateRelease, updateEnded };
});

it.layer(NodeServices.layer)("OpenCodex shared lease", (it) => {
  it.effect("a concurrent Home sync reports updating while apply holds the lease", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.versions.set("mac-studio", "2.90.0");
      const fake = yield* scriptedOcx(fleet);
      fake.script.holdUpdate = true;
      const { update } = yield* setup(fleet);
      const applying = yield* Effect.forkChild(update.check);
      yield* Deferred.await(fake.updateStarted);
      const report = yield* fake.sync.run(scope);
      yield* Deferred.succeed(fake.updateRelease, undefined);
      yield* Fiber.join(applying);
      expect(fake.script.syncExit).toBe(7);
      expect(report.members[0]).toMatchObject({
        alias: null,
        state: "skipped",
        reason: "updating",
      });
    }),
  );

  it.effect("a sync lease refuses apply without remembering the target, then permits retry", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.versions.set("mac-studio", "2.90.0");
      const fake = yield* scriptedOcx(fleet);
      fake.script.holdSync = true;
      const { update } = yield* setup(fleet);
      const syncing = yield* Effect.forkChild(fake.sync.run(scope));
      yield* Deferred.await(fake.syncStarted);
      yield* update.check;
      expect(fake.script.applyExit).toBe(10);
      expect(fake.script.refusal).toBe("sync-in-progress");
      expect(fake.script.mutations).toBe(0);
      yield* Deferred.succeed(fake.syncRelease, undefined);
      yield* Fiber.join(syncing);
      yield* update.checkNow;
      expect(fleet.applyCalls).toBe(2);
      expect(fake.script.mutations).toBe(1);
      expect(fleet.installs).toEqual([]);
    }),
  );

  it.effect("an apply paused before its deadline check refuses after notAfter", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.versions.set("mac-studio", "2.90.0");
      const fake = yield* scriptedOcx(fleet);
      fake.script.holdUpdate = true;
      const { update } = yield* setup(fleet);
      const applying = yield* Effect.forkChild(update.check);
      yield* Deferred.await(fake.updateStarted);
      yield* TestClock.adjust(5 * MINUTE + 1);
      yield* Deferred.succeed(fake.updateRelease, undefined);
      yield* Fiber.join(applying);
      expect(fake.script.applyExit).toBe(10);
      expect(fake.script.refusal).toBe("deadline-passed");
      expect(fake.script.mutations).toBe(0);
      expect((yield* update.status)?.members[0]).toMatchObject({
        phase: "rolled-back",
        reason: "install-refused",
      });
    }),
  );

  it.effect("a published mutation stays in flight and prevents fencing until released", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.versions.set("mac-studio", "2.90.0");
      const fake = yield* scriptedOcx(fleet);
      fake.script.loseApplyReply = true;
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.inFlight).toBe(true);
      yield* TestClock.adjust(20 * MINUTE);
      yield* update.check;
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.inFlight).toBe(true);
      expect(fleet.planInFlight.slice(2)).toEqual([true, true]);
      expect(fleet.holds).toBe(1);
      expect((yield* update.status)?.reason).toBe("apply-uncertain");
      yield* Deferred.succeed(fake.updateRelease, undefined);
      yield* Deferred.await(fake.updateEnded);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.holds).toBe(0);
    }),
  );
});
