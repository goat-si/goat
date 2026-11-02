import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as ServerConfig from "../config.ts";
import * as AutomationHold from "../automationHold.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as TestClock from "effect/testing/TestClock";

import { decodeState, encodeState } from "./ocxUpdateWindow.ts";
import { makeFleet, MINUTE, phases, service, setup } from "./OpenCodexManagedUpdate.testkit.ts";

const decodeFailed = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ failedTargets: Schema.Record(Schema.String, Schema.String) }),
  ),
);

it.layer(NodeServices.layer)("OpenCodex SSH replacement follow-up", (it) => {
  it.effect("keeps an in-flight plan pending until a later determinate check", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.versions.set("mac-studio", "2.90.0");
      fleet.orchestrated = true;
      fleet.inFlight = true;
      fleet.automatic = true;
      fleet.hub = false;
      fleet.runtimeReplaced = "1.1.0";
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.planReads).toBe(1);
      fleet.inFlight = false;
      fleet.planMode = "none";
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.planReads).toBe(2);
      yield* TestClock.adjust(6 * 60 * MINUTE);
      yield* update.check;
      expect(fleet.planReads).toBe(2);
    }),
  );

  it.effect("does not run a follow-up while automatic server updates are disabled", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.hub = false;
      fleet.runtimeReplaced = "1.1.0";
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.planReads).toBe(0);
      fleet.automatic = true;
      fleet.planMode = "none";
      yield* update.checkNow;
      expect(fleet.planReads).toBeGreaterThan(0);
    }),
  );

  it.effect("settles a follow-up coordinated by another Home", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.automatic = true;
      fleet.hub = false;
      fleet.childRole = true;
      fleet.runtimeReplaced = "1.1.0";
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect((yield* update.status)?.reason).toBe("coordinated-by-home");
      fleet.childRole = false;
      expect((yield* update.checkNow)?.reason).toBe("coordinated-by-home");
      expect(fleet.installs).toEqual([]);
    }),
  );

  it.effect("settles a follow-up after a rolled-back window closes", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.versions.set("mac-studio", "2.90.0");
      fleet.orchestrated = true;
      fleet.applyResult = "rolled-back";
      fleet.automatic = true;
      fleet.hub = false;
      fleet.runtimeReplaced = "1.1.0";
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.applyCalls).toBe(1);
      yield* update.checkNow;
      expect(fleet.applyCalls).toBe(1);
    }),
  );
  it.effect("remembers failures only for steps that actually started", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.failOnce.add("home@2.90.0");
      const { update, baseDir } = yield* setup(fleet);
      yield* update.check;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      const state = yield* decodeFailed(
        yield* fs.readFileString(path.join(config.stateDir, "opencodex-update.json")),
      );
      expect(state.failedTargets).toEqual({ "": "2.90.0" });
    }),
  );
  it.effect("never invokes the managed installer for an incomplete adopted step", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "uncertain";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update, baseDir } = yield* setup(fleet);
      yield* update.check;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      const file = path.join(config.stateDir, "opencodex-update.json");
      const state = Option.getOrThrow(decodeState(yield* fs.readFileString(file)));
      if (state.window === undefined) throw new Error("Expected a window");
      const { orchestrated: _orchestrated, ...window } = state.window;
      yield* fs.writeFileString(
        file,
        encodeState({
          ...state,
          window: { ...window, steps: window.steps.map((step) => ({ ...step, restored: false })) },
        }),
      );
      fleet.holds = 0;
      const resumed = yield* service(fleet, baseDir);
      yield* resumed.check;
      expect(fleet.installs).toEqual([]);
      expect((yield* resumed.status)?.reason).toBe("rollback-incomplete");
    }),
  );
  it.effect("does not remember a refused adopted update as a failed target", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "refused";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.applyCalls).toBe(1);
      yield* update.checkNow;
      expect(fleet.applyCalls).toBe(2);
      expect(fleet.installs).toEqual([]);
    }),
  );

  it.effect("waits for a person to restore an adopted install after probation fails", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      fleet.unhealthyAt.add("home@2.90.0");
      yield* TestClock.adjust(MINUTE);
      yield* update.check;
      expect(phases(yield* update.status)).toEqual([
        [null, "rollback-failed", "probation-health-failed"],
      ]);
      expect(fleet.installs).toEqual([]);
      fleet.versions.set(null, "2.89.0");
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(phases(yield* update.status)).toEqual([
        [null, "rolled-back", "probation-health-failed"],
      ]);
      expect(fleet.installs).toEqual([]);
    }),
  );
  it.effect("keeps the window admission hold through sync after a conclusive adopted apply", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.holdsDuringSync[0]).toBeGreaterThan(0);
      expect(fleet.holds).toBe(0);
    }),
  );
  it.effect(
    "rechecks an interrupted dispatch in the same service before the admission ceiling",
    () =>
      Effect.gen(function* () {
        const fleet = makeFleet({ homeOwnership: "adopted" });
        fleet.orchestrated = true;
        fleet.versions.set("mac-studio", "2.90.0");
        const started = yield* Deferred.make<void>();
        fleet.onApply = Effect.sync(() => {
          fleet.inFlight = true;
        }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never));
        const { update } = yield* setup(fleet);
        const dispatch = yield* Effect.forkChild(update.check);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(dispatch);
        expect(fleet.holds).toBe(1);
        yield* TestClock.adjust(10 * MINUTE);
        yield* update.check;
        expect(fleet.planReads).toBeGreaterThan(2);
        yield* TestClock.adjust(40 * MINUTE);
        yield* update.check;
        expect(fleet.holds).toBe(0);
      }),
  );

  it.effect("rechecks a defective dispatch in the same service before the admission ceiling", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.versions.set("mac-studio", "2.90.0");
      fleet.onApply = Effect.sync(() => {
        fleet.inFlight = true;
      }).pipe(Effect.andThen(Effect.die("dispatch fault")));
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.holds).toBe(1);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.planReads).toBeGreaterThan(2);
      yield* TestClock.adjust(40 * MINUTE);
      yield* update.check;
      expect(fleet.holds).toBe(0);
    }),
  );
  it.effect("releases a persisted pending Home at the ceiling while automation is held", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "uncertain";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update, baseDir } = yield* setup(fleet);
      yield* update.check;
      yield* TestClock.adjust(50 * MINUTE - 5_000);
      fleet.holds = 0;
      fleet.homeHolds = 0;
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      yield* Effect.gen(function* () {
        const scheduler = yield* Scheduler.Scheduler;
        yield* service(fleet, baseDir, scheduler);
        expect(fleet.holds).toBe(1);
        const reads = fleet.planReads;
        const applies = fleet.applyCalls;
        yield* TestClock.adjust(5_000);
        expect(fleet.holds).toBe(0);
        expect(fleet.planReads).toBe(reads);
        expect(fleet.applyCalls).toBe(applies);
      }).pipe(
        Effect.provide(Scheduler.layer),
        Effect.provideService(AutomationHold.AutomationHold, hold),
      );
    }),
  );
  it.effect("reconciles a stale retained Home hold even before the next due time", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "uncertain";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update, baseDir } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.holds).toBe(1);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      const file = path.join(config.stateDir, "opencodex-update.json");
      const state = Option.getOrThrow(decodeState(yield* fs.readFileString(file)));
      if (state.window === undefined) throw new Error("Expected a window");
      const { orchestrated: _orchestrated, ...window } = state.window;
      yield* fs.writeFileString(file, encodeState({ ...state, window }));
      yield* update.check;
      expect(fleet.holds).toBe(0);
    }),
  );
  it.effect("does not postpone an overdue retry after a late dispatch failure", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.versions.set("mac-studio", "2.90.0");
      const started = yield* Deferred.make<void>();
      const fail = yield* Deferred.make<void>();
      fleet.onApply = Effect.sync(() => {
        fleet.inFlight = true;
      }).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(fail)),
        Effect.andThen(Effect.die("late dispatch fault")),
      );
      const { update } = yield* setup(fleet);
      const dispatch = yield* Effect.forkChild(update.check);
      yield* Deferred.await(started);
      yield* TestClock.adjust(49 * MINUTE);
      yield* Deferred.succeed(fail, undefined);
      yield* Fiber.join(dispatch);
      yield* update.check;
      expect(fleet.planReads).toBeGreaterThan(2);
      yield* TestClock.adjust(MINUTE);
      yield* update.admissionGuard;
      expect(fleet.holds).toBe(0);
    }),
  );
  it.effect("syncs the recovered target under admission before recording probation", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "uncertain";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update, baseDir } = yield* setup(fleet);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      let phaseAtSync: string | undefined;
      fleet.onSync = fs.readFileString(path.join(config.stateDir, "opencodex-update.json")).pipe(
        Effect.map((raw) => Option.getOrThrow(decodeState(raw))),
        Effect.tap((state) =>
          Effect.sync(() => {
            phaseAtSync = state.members.find((member) => member.alias === null)?.phase;
          }),
        ),
        Effect.asVoid,
        Effect.orDie,
      );
      yield* update.check;
      fleet.versions.set(null, "2.90.0");
      fleet.inFlight = false;
      yield* TestClock.adjust(20 * MINUTE);
      yield* update.check;
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.log).toEqual(["sync:home@2.90.0"]);
      expect(phaseAtSync).toBe("installed");
      expect(fleet.holdsDuringSync[0]).toBeGreaterThan(0);
      expect(fleet.exclusiveDuringSync).toEqual([1]);
      expect(yield* update.status).toMatchObject({
        members: [{ phase: "probation" }],
        sync: { members: [{ alias: null, state: "synced" }] },
      });
    }),
  );
  it.effect("releases the ceiling while a plan read is blocked and rejects its stale result", () =>
    Effect.gen(function* () {
      const disk = yield* FileSystem.FileSystem;
      const files = yield* Ref.make(new Map<string, string>());
      const relevant = (file: string) =>
        file.endsWith("/opencodex-update.json") || file.endsWith("/opencodex-update.json.tmp");
      const fs = FileSystem.FileSystem.of({
        ...disk,
        exists: (file) =>
          relevant(file)
            ? Ref.get(files).pipe(Effect.map((current) => current.has(file)))
            : disk.exists(file),
        readFileString: (file, options) =>
          relevant(file)
            ? Ref.get(files).pipe(
                Effect.flatMap((current) =>
                  current.has(file)
                    ? Effect.succeed(current.get(file) ?? "")
                    : disk.readFileString(file, options),
                ),
              )
            : disk.readFileString(file, options),
        writeFileString: (file, data, options) =>
          relevant(file)
            ? Ref.update(files, (current) => new Map(current).set(file, data))
            : disk.writeFileString(file, data, options),
        rename: (from, to) =>
          relevant(from) && relevant(to)
            ? Ref.update(files, (current) => {
                const next = new Map(current);
                const data = next.get(from);
                if (data === undefined) throw new Error("Missing state");
                next.set(to, data);
                next.delete(from);
                return next;
              })
            : disk.rename(from, to),
        makeDirectory: (file, options) =>
          file.endsWith("/userdata") ? Effect.void : disk.makeDirectory(file, options),
      });
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "uncertain";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update, baseDir } = yield* setup(fleet, fs);
      yield* update.check;
      fleet.inFlight = false;
      fleet.versions.set(null, "2.90.0");
      yield* TestClock.adjust(20 * MINUTE);
      yield* update.check;
      yield* TestClock.adjust(29 * MINUTE);
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      fleet.onPlan = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
      );
      const checking = yield* Effect.forkChild(update.checkNow);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(MINUTE);
      const callsBeforeGuard = fleet.homeHoldCalls;
      const done = yield* Deferred.make<void>();
      const guarding = yield* Effect.forkChild(
        update.admissionGuard.pipe(Effect.andThen(Deferred.succeed(done, undefined))),
      );
      yield* TestClock.adjust(1);
      const releasedBeforeResume = yield* Deferred.isDone(done);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(checking);
      yield* Fiber.join(guarding);
      expect(releasedBeforeResume).toBe(true);
      expect(fleet.holds).toBe(0);
      expect(fleet.homeHoldCalls).toBe(callsBeforeGuard);
      expect(fleet.log).toEqual([]);
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      const state = Option.getOrThrow(
        decodeState(yield* fs.readFileString(path.join(config.stateDir, "opencodex-update.json"))),
      );
      expect(state.members.find((member) => member.alias === null)?.reason).toBe("apply-overrun");
      expect(state.window?.orchestrated?.[""]?.observed?.version).toBe("2.90.0");
    }),
  );
});
