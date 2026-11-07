import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, OpenCodexUpdateMemberRecord } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import * as Installation from "../opencodex/OpenCodexInstallation.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import { installedWorld, urlOf } from "../opencodex/OpenCodexInstallation.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HubParity from "./HubParity.ts";
import { makeFleet, MINUTE, phases, service, setup } from "./OpenCodexManagedUpdate.testkit.ts";
import * as UpdateHost from "./OpenCodexUpdateHost.ts";
import { fleetSnapshot } from "./parity.testkit.ts";

const decodeOldState = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      members: Schema.Array(OpenCodexUpdateMemberRecord),
      failedTargets: Schema.Record(Schema.String, Schema.String),
      window: Schema.Struct({
        targetVersion: Schema.String,
        children: Schema.Array(Schema.String),
        steps: Schema.Array(
          Schema.Struct({
            alias: Schema.NullOr(Schema.String),
            fromVersion: Schema.String,
            restored: Schema.optional(Schema.Boolean),
          }),
        ),
        probationEndsAt: Schema.optional(Schema.Number),
        baseline: Schema.Record(
          Schema.String,
          Schema.Literals(["ok", "degraded", "broken", "unproven"]),
        ),
        roles: Schema.Record(Schema.String, Schema.String),
        startedAt: Schema.Record(Schema.String, Schema.Number),
        processIds: Schema.Record(Schema.String, Schema.Int),
        restoring: Schema.optional(Schema.String),
        failedMember: Schema.optional(Schema.String),
      }),
    }),
  ),
);

it.layer(NodeServices.layer)("OpenCodex managed update", (it) => {
  it.effect("applies an adopted Home through its ocx and accepts after probation", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.applyCalls).toBe(1);
      expect(fleet.installs).toEqual([]);
      expect(phases(yield* update.status)).toEqual([[null, "probation", undefined]]);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(phases(yield* update.status)).toEqual([[null, "accepted", undefined]]);
    }),
  );

  it.effect("never installs over an adopted Home after ocx refuses", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "refused";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.applyCalls).toBe(1);
      expect(fleet.installs).toEqual([]);
      expect(phases(yield* update.status)).toEqual([[null, "rolled-back", "install-refused"]]);
    }),
  );

  it.effect("holds admission for an uncertain apply until two fenced observations", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "uncertain";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(yield* update.status).toMatchObject({ decision: "wait", reason: "apply-uncertain" });
      expect(fleet.holds).toBe(1);
      yield* TestClock.adjust(20 * MINUTE);
      yield* update.check;
      expect(fleet.holds).toBe(1);
      fleet.inFlight = false;
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.holds).toBe(1);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.holds).toBe(0);
      expect(fleet.installs).toEqual([]);
      expect(phases(yield* update.status)).toEqual([[null, "rolled-back", "install-failed"]]);
    }),
  );

  it.effect("does not fence an uncertain apply with two manual checks in one retry interval", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "uncertain";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      fleet.inFlight = false;
      yield* TestClock.adjust(20 * MINUTE);
      yield* update.check;
      yield* TestClock.adjust(1);
      expect((yield* update.checkNow)?.reason).toBe("apply-uncertain");
      expect(fleet.holds).toBe(1);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.holds).toBe(0);
    }),
  );

  it.effect("re-holds admission for an uncertain persisted window after restart", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "uncertain";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update, baseDir } = yield* setup(fleet);
      yield* update.check;
      fleet.holds = 0;
      const resumed = yield* service(fleet, baseDir);
      expect(fleet.holds).toBe(1);
      yield* resumed.check;
      expect(yield* resumed.status).toMatchObject({ decision: "wait", reason: "apply-uncertain" });
    }),
  );

  it.effect("refuses when the pre-apply token or binary identity changes", () =>
    Effect.gen(function* () {
      for (const changed of ["token", "servingPath", "cliPath"] as const) {
        const fleet = makeFleet({ homeOwnership: "adopted" });
        fleet.orchestrated = true;
        fleet.changedOnRead = changed;
        fleet.versions.set("mac-studio", "2.90.0");
        const { update } = yield* setup(fleet);
        yield* update.check;
        expect(fleet.applyCalls).toBe(0);
        expect(fleet.installs).toEqual([]);
        expect(phases(yield* update.status)).toEqual([[null, "rolled-back", "install-refused"]]);
      }
    }),
  );

  it.effect("recovers an uncertain apply on the target into probation", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "uncertain";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      fleet.versions.set(null, "2.90.0");
      fleet.inFlight = false;
      yield* TestClock.adjust(20 * MINUTE);
      yield* update.check;
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.holds).toBe(0);
      expect(phases(yield* update.status)).toEqual([[null, "probation", undefined]]);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(phases(yield* update.status)).toEqual([[null, "accepted", undefined]]);
    }),
  );

  it.effect("releases admission at the apply overrun ceiling without closing the window", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "uncertain";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      yield* TestClock.adjust(50 * MINUTE);
      yield* update.check;
      expect(fleet.holds).toBe(0);
      expect(yield* update.status).toMatchObject({
        decision: "wait",
        reason: "apply-uncertain",
        members: [{ phase: "rollback-failed", reason: "apply-overrun" }],
      });
    }),
  );

  it.effect("advances a stored window even when this machine becomes a Child", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "uncertain";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      fleet.childRole = true;
      fleet.inFlight = false;
      yield* TestClock.adjust(20 * MINUTE);
      yield* update.check;
      expect(yield* update.status).toMatchObject({ decision: "wait", reason: "apply-uncertain" });
    }),
  );

  it.effect("runs an SSH follow-up with hub disabled and keeps unknown plans pending", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.versions.set("mac-studio", "2.90.0");
      fleet.orchestrated = true;
      fleet.planMode = "unknown";
      fleet.automatic = true;
      fleet.runtimeReplaced = "1.1.0";
      fleet.hub = false;
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.planReads).toBe(1);
      fleet.planMode = "none";
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.planReads).toBe(2);
      yield* TestClock.adjust(6 * 60 * MINUTE);
      yield* update.check;
      expect(fleet.planReads).toBe(2);
    }),
  );

  it.effect("clears a fenced uncertain window after a person reinstalls the previous version", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "uncertain";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      fleet.versions.set(null, "2.88.0");
      fleet.inFlight = false;
      yield* TestClock.adjust(20 * MINUTE);
      yield* update.check;
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(yield* update.status).toMatchObject({
        decision: "wait",
        reason: "apply-uncertain",
        members: [{ phase: "rollback-failed" }],
      });
      fleet.versions.set(null, "2.89.0");
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(phases(yield* update.status)).toEqual([[null, "rolled-back", "install-failed"]]);
      expect(fleet.installs).toEqual([]);
    }),
  );

  it.effect("remembers ocx rollback and does not retry or use GOAT's installer", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.applyResult = "rolled-back";
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(phases(yield* update.status)).toEqual([[null, "rolled-back", "install-failed"]]);
      expect((yield* update.checkNow)?.reason).toBe("previous-failure");
      expect(fleet.applyCalls).toBe(1);
      expect(fleet.installs).toEqual([]);
    }),
  );

  it.effect("re-holds a pending apply after the GOAT process stops during dispatch", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.versions.set("mac-studio", "2.90.0");
      const started = yield* Deferred.make<void>();
      fleet.onApply = Effect.sync(() => {
        fleet.inFlight = true;
      }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never));
      const { update, baseDir } = yield* setup(fleet);
      const running = yield* Effect.forkChild(update.check);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      expect(fleet.holds).toBe(1);
      fleet.holds = 0;
      const resumed = yield* service(fleet, baseDir);
      expect(fleet.holds).toBe(1);
      yield* resumed.check;
      expect(yield* resumed.status).toMatchObject({ decision: "wait", reason: "apply-uncertain" });
      fleet.inFlight = false;
      yield* TestClock.adjust(20 * MINUTE);
      yield* resumed.check;
      yield* TestClock.adjust(10 * MINUTE);
      yield* resumed.check;
      expect(fleet.holds).toBe(0);
      expect(fleet.installs).toEqual([]);
    }),
  );

  it.effect("writes adopted steps as restored for an older GOAT state decoder", () =>
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
      const state = yield* decodeOldState(
        yield* fs.readFileString(path.join(config.stateDir, "opencodex-update.json")),
      );
      expect(state.window.steps).toEqual([{ alias: null, fromVersion: "2.89.0", restored: true }]);
    }),
  );

  it.effect("moves the Home, then the Child, and accepts both after probation", () =>
    Effect.gen(function* () {
      const { fleet, update } = yield* setup();
      yield* update.check;
      expect(fleet.installs).toEqual(["home@2.90.0", "mac-studio@2.90.0"]);
      // Admission is held only while members install, never through probation.
      expect(fleet.holds).toBe(0);
      expect(phases(yield* update.status)).toEqual([
        [null, "probation", undefined],
        ["mac-studio", "probation", undefined],
      ]);

      yield* TestClock.adjust(10 * MINUTE - 1);
      yield* update.check;
      expect(phases(yield* update.status)?.map(([, phase]) => phase)).toEqual([
        "probation",
        "probation",
      ]);

      yield* TestClock.adjust(1);
      yield* update.check;
      expect(phases(yield* update.status)).toEqual([
        [null, "accepted", undefined],
        ["mac-studio", "accepted", undefined],
      ]);
      expect(fleet.installs).toHaveLength(2);
    }),
  );

  it.effect("syncs each member right after its install, Home first, and reports it", () =>
    Effect.gen(function* () {
      const { fleet, update } = yield* setup();
      const status = yield* update.checkNow;
      expect(fleet.log).toEqual([
        "install:home",
        "sync:home@2.90.0",
        "install:mac-studio",
        "sync:mac-studio@2.90.0",
      ]);
      expect(status?.sync).toMatchObject({
        trigger: "update",
        targetVersion: "2.90.0",
        members: [
          { alias: null, state: "synced" },
          { alias: "mac-studio", state: "synced" },
        ],
      });
    }),
  );

  it.effect("accepts a Child whose sync restarted its runtime after the install", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.syncRestarts.add("mac-studio");
      const { update } = yield* setup(fleet);
      yield* update.check;
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(phases(yield* update.status)).toEqual([
        [null, "accepted", undefined],
        ["mac-studio", "accepted", undefined],
      ]);
      expect(fleet.installs).toHaveLength(2);
    }),
  );

  it.effect("reports a failed sync and keeps the update", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.syncFails.add("mac-studio");
      const { update } = yield* setup(fleet);
      const status = yield* update.checkNow;
      expect(phases(status)?.map(([, phase]) => phase)).toEqual(["probation", "probation"]);
      expect(status?.sync?.members).toEqual([
        { alias: null, state: "synced", restartCodex: true },
        { alias: "mac-studio", state: "failed", restartCodex: true, reason: "exit-1" },
      ]);
    }),
  );

  it.effect("keeps another version's sync out of the update status", () =>
    Effect.gen(function* () {
      const { fleet, update } = yield* setup();
      yield* update.check;
      expect((yield* update.status)?.sync?.targetVersion).toBe("2.90.0");
      fleet.syncReport = { ...fleet.syncReport!, targetVersion: "2.91.0" };
      expect((yield* update.status)?.sync).toBeUndefined();
    }),
  );

  it.effect("holds manual syncs off for a window restored after a GOAT restart", () =>
    Effect.gen(function* () {
      const { fleet, baseDir, update } = yield* setup();
      yield* update.check;
      expect(fleet.updating).toBe(true);
      // A restart with the hub switched off never runs a check, and still holds them off.
      fleet.updating = undefined;
      fleet.hub = false;
      yield* service(fleet, baseDir);
      expect(fleet.updating).toBe(true);

      fleet.hub = true;
      const restarted = yield* service(fleet, baseDir);
      yield* TestClock.adjust(10 * MINUTE);
      yield* restarted.check;
      expect(fleet.updating).toBe(false);
    }),
  );

  it.effect("restores the Home when its Child fails the health check, and never retries", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.unhealthyAt.add("mac-studio@2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.installs).toEqual([
        "home@2.90.0",
        "mac-studio@2.90.0",
        "mac-studio@2.86.0",
        "home@2.89.0",
      ]);
      expect(phases(yield* update.status)).toEqual([
        ["mac-studio", "rolled-back", "health-failed"],
        [null, "rolled-back", "health-failed"],
      ]);

      yield* TestClock.adjust(6 * 60 * MINUTE);
      yield* update.check;
      expect(fleet.installs).toHaveLength(4);
      expect(yield* update.status).toMatchObject({
        decision: "none",
        reason: "previous-failure",
      });
    }),
  );

  it.effect("judges a Child's parity after its own step, not after the Home's", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.relayAuth = true;
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.installs).toEqual(["home@2.90.0", "mac-studio@2.90.0"]);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(phases(yield* update.status)?.map(([, phase]) => phase)).toEqual([
        "accepted",
        "accepted",
      ]);
    }),
  );

  it.effect("rolls back Children before the Home and stays open until parity recovers", () =>
    Effect.gen(function* () {
      const { fleet, update } = yield* setup();
      yield* update.check;
      fleet.parity.set("mac-studio", "broken");
      // The runtime still serves, so its restore waits for the pair to be idle.
      fleet.running.set("mac-studio", 1);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.installs).toHaveLength(2);
      expect(yield* update.status).toMatchObject({ reason: "rollback-incomplete" });
      expect(fleet.holds).toBe(0);

      fleet.running.set("mac-studio", 0);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.installs.slice(2)).toEqual(["mac-studio@2.86.0", "home@2.89.0"]);
      expect(yield* update.status).toMatchObject({
        decision: "wait",
        reason: "rollback-incomplete",
      });

      // Parity recovers on the restored versions; nothing is reinstalled to close the window.
      fleet.parity.set("mac-studio", "ok");
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.installs).toHaveLength(4);
      expect(yield* update.status).toMatchObject({ decision: "none", reason: "window-closed" });
      expect(phases(yield* update.status)).toEqual([
        ["mac-studio", "rolled-back", "probation-parity-broken"],
        [null, "rolled-back", "probation-parity-broken"],
      ]);
    }),
  );

  it.effect("keeps probation across a GOAT restart and rolls back an unverified install", () =>
    Effect.gen(function* () {
      const { fleet, baseDir, update } = yield* setup();
      yield* update.check;
      const restarted = yield* service(fleet, baseDir);
      yield* TestClock.adjust(10 * MINUTE);
      yield* restarted.check;
      expect(fleet.installs).toHaveLength(2);
      expect(phases(yield* restarted.status)?.map(([, phase]) => phase)).toEqual([
        "accepted",
        "accepted",
      ]);

      // GOAT stopped between installing the Home and checking its health.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      yield* fs.writeFileString(
        path.join(config.stateDir, "opencodex-update.json"),
        JSON.stringify({
          members: [
            {
              alias: null,
              phase: "installed",
              fromVersion: "2.90.0",
              targetVersion: "2.91.0",
              at: 0,
            },
          ],
          failedTargets: {},
          window: {
            targetVersion: "2.91.0",
            steps: [{ alias: null, fromVersion: "2.90.0" }],
            baseline: {},
            children: [],
            roles: { "": "standalone" },
            startedAt: {},
            processIds: {},
          },
        }),
      );
      fleet.versions.set(null, "2.91.0");
      yield* (yield* service(fleet, baseDir)).check;
      expect(fleet.installs.slice(2)).toEqual(["home@2.90.0"]);
    }),
  );

  it.effect("waits when a member cannot hold turn admission", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.noAdmission.add("mac-studio");
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.installs).toEqual([]);
      expect(fleet.holds).toBe(0);
      expect(yield* update.status).toMatchObject({
        decision: "wait",
        reason: "admission-unsupported",
        waitingOn: ["mac-studio"],
      });
    }),
  );

  it.effect("only advises adopted installs", () =>
    Effect.gen(function* () {
      const { fleet, update } = yield* setup(
        makeFleet({ homeOwnership: "adopted", childOwnership: "adopted" }),
      );
      yield* update.check;
      expect(fleet.installs).toEqual([]);
      expect(yield* update.status).toMatchObject({
        decision: "none",
        reason: "advice-only",
        advisories: [
          { alias: null, version: "2.89.0", targetVersion: "2.90.0" },
          { alias: "mac-studio", version: "2.86.0", targetVersion: "2.90.0" },
        ],
      });
    }),
  );

  it.effect("rolls back when a member restarts during probation, even if it answers again", () =>
    Effect.gen(function* () {
      const { fleet, update } = yield* setup();
      yield* update.check;
      yield* TestClock.adjust(MINUTE);
      yield* update.check;
      expect(fleet.installs).toHaveLength(2);

      // The Child crashed right after its health check and was restarted on the same version
      // within the uptime tolerance; only its process id shows it.
      fleet.processId.set("mac-studio", fleet.processId.get("mac-studio")! + 1);
      yield* TestClock.adjust(MINUTE);
      yield* update.check;
      expect(fleet.installs.slice(2)).toEqual(["mac-studio@2.86.0", "home@2.89.0"]);
      expect(phases(yield* update.status)).toEqual([
        ["mac-studio", "rolled-back", "probation-health-failed"],
        [null, "rolled-back", "probation-health-failed"],
      ]);
    }),
  );

  it.effect("keeps the Home on the target until its Child's restore is proven", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.unhealthyAt.add("mac-studio@2.90.0");
      fleet.failOnce.add("mac-studio@2.86.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.installs).toEqual(["home@2.90.0", "mac-studio@2.90.0", "mac-studio@2.86.0"]);
      expect(yield* update.status).toMatchObject({
        decision: "wait",
        reason: "rollback-incomplete",
      });
      expect(phases(yield* update.status)).toEqual([
        [null, "probation", undefined],
        ["mac-studio", "rollback-failed", "health-failed"],
      ]);

      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.installs.slice(3)).toEqual(["mac-studio@2.86.0", "home@2.89.0"]);
      expect(phases(yield* update.status)).toEqual([
        ["mac-studio", "rolled-back", "health-failed"],
        [null, "rolled-back", "health-failed"],
      ]);
    }),
  );

  it.effect("waits while any member of the pair is busy, then moves in the next idle window", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.running.set("mac-studio", 1);
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.installs).toEqual([]);
      expect(yield* update.status).toMatchObject({
        decision: "wait",
        reason: "busy",
        waitingOn: ["mac-studio"],
      });

      fleet.running.set("mac-studio", 0);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.installs).toEqual(["home@2.90.0", "mac-studio@2.90.0"]);
    }),
  );

  it.effect("checks now when a person asks, without waiting out the retry timer", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.running.set("mac-studio", 1);
      const { update } = yield* setup(fleet);
      yield* update.check;
      fleet.running.set("mac-studio", 0);

      // The scheduler's next check is ten minutes away, so it does nothing yet.
      yield* update.check;
      expect(fleet.installs).toEqual([]);

      const status = yield* update.checkNow;
      expect(fleet.installs).toEqual(["home@2.90.0", "mac-studio@2.90.0"]);
      expect(status).toMatchObject({ decision: "update", targetVersion: "2.90.0" });
    }),
  );

  it.effect("does nothing while the hub or goatclaw is off", () =>
    Effect.gen(function* () {
      for (const off of ["hub", "goatclaw"] as const) {
        const fleet = makeFleet();
        fleet[off] = false;
        const { update } = yield* setup(fleet);
        yield* update.check;
        expect(fleet.installs).toEqual([]);
        expect(yield* update.status).toBeUndefined();
      }
    }),
  );
  it.effect("restores a failed Child under work but keeps the busy Home until it is idle", () =>
    Effect.gen(function* () {
      const { fleet, update } = yield* setup();
      yield* update.check;
      // The Child crashes during probation while the healthy Home is serving a turn.
      fleet.unhealthyAt.add("mac-studio@2.90.0");
      fleet.running.set(null, 1);
      yield* TestClock.adjust(MINUTE);
      yield* update.check;
      expect(fleet.installs.slice(2)).toEqual(["mac-studio@2.86.0"]);
      expect(yield* update.status).toMatchObject({ reason: "rollback-incomplete" });

      // The restored Child picks up work while the Home goes idle: the Home still waits.
      fleet.running.set(null, 0);
      fleet.running.set("mac-studio", 1);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.installs).toHaveLength(3);

      fleet.running.set("mac-studio", 0);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.installs.slice(3)).toEqual(["home@2.89.0"]);
      expect(phases(yield* update.status)).toEqual([
        ["mac-studio", "rolled-back", "probation-health-failed"],
        [null, "rolled-back", "probation-health-failed"],
      ]);
    }),
  );

  it.effect("restores a failed Home only when its Children are idle", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      // The Child is already on the target, so the window moves only the Home.
      fleet.versions.set("mac-studio", "2.90.0");
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.installs).toEqual(["home@2.90.0"]);

      fleet.unhealthyAt.add("home@2.90.0");
      fleet.running.set("mac-studio", 1);
      yield* TestClock.adjust(MINUTE);
      yield* update.check;
      expect(fleet.installs).toHaveLength(1);
      expect(yield* update.status).toMatchObject({ reason: "rollback-incomplete" });

      fleet.running.set("mac-studio", 0);
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.installs.slice(1)).toEqual(["home@2.89.0"]);
    }),
  );
});

it.effect(
  "counts a request admitted before the hold even if it commits after the thread read",
  () =>
    Effect.gen(function* () {
      let inFlight = 1;
      const context = yield* Layer.build(
        UpdateHost.layerHost.pipe(
          Layer.provide(Layer.mock(Inventory.OpenCodexInventory)({})),
          Layer.provide(Layer.mock(Inventory.OpenCodexInventory)({})),
          Layer.provide(
            Layer.mock(HubParity.HubParity)({ readLocal: Effect.succeed(fleetSnapshot("home")) }),
          ),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              // The admitted request commits and finishes right after this read.
              listProjectThreads: () =>
                Effect.sync(() => {
                  inFlight = 0;
                  return [];
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(RuntimeAdmission.RuntimeAdmission)({
              inFlight: Effect.sync(() => inFlight),
            }),
          ),
          Layer.provide(Layer.mock(HostThreads.HostThreadsMcpService)({})),
          Layer.provide(Layer.mock(Dispatch.SshRemoteDispatch)({})),
          Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({})),
          Layer.provide(Layer.mock(Installation.OpenCodexInstallation)({})),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.succeed(HostProcess.Environment, {})),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/")),
        ),
      );
      const host = yield* UpdateHost.OpenCodexUpdateHost.pipe(Effect.provideContext(context));
      const member = yield* host.member(null, {
        environmentId: EnvironmentId.make("hub-fixture"),
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
        requestNamespace: "test",
        thread: undefined,
        client: { sessionId: "test", label: "Test", access: "read-only" },
      });
      expect(member.runningTurns).toBe(1);
    }),
);

it.live("managed update and rollback use only retained compiled release pins", () =>
  Effect.gen(function* () {
    const world = yield* installedWorld();
    const restarts: Array<string> = [];
    const remoteScripts: Array<string> = [];
    const context = yield* Layer.build(
      UpdateHost.layerHost.pipe(
        Layer.provide(Layer.mock(Inventory.OpenCodexInventory)({})),
        Layer.provide(Layer.mock(HubParity.HubParity)({})),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(Layer.mock(RuntimeAdmission.RuntimeAdmission)({})),
        Layer.provide(Layer.mock(HostThreads.HostThreadsMcpService)({})),
        Layer.provide(
          Layer.mock(Dispatch.SshRemoteDispatch)({
            provisionedRuntimeExecutable: () => Effect.sync((): string | undefined => undefined),
            runHostScript: ({ script }) =>
              Effect.sync(() => {
                remoteScripts.push(script);
                return { stdout: "\n__goat_ocx_exit=0\n", stderr: "" };
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: (input) =>
              Effect.sync(() => {
                restarts.push(`${input.command} ${input.args.join(" ")}`);
                return {
                  stdout: "",
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
          }),
        ),
        Layer.provide(Layer.succeed(Installation.OpenCodexInstallation, world.service)),
        Layer.provide(Layer.succeed(Installation.ReleaseCatalog, world.catalog)),
        Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
        Layer.provide(Layer.succeed(HostProcess.Architecture, "x64")),
        Layer.provide(Layer.succeed(HostProcess.Environment, {})),
        Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/")),
      ),
    );
    const host = yield* UpdateHost.OpenCodexUpdateHost.pipe(Effect.provideContext(context));
    // The newest release GOAT can install is its compiled pin, never a registry's latest.
    expect(yield* host.latestRelease).toEqual({
      version: "2.92.0",
      publishedAt: "2026-10-24T00:00:00Z",
    });
    const release = (version: string) =>
      world.path.join(world.prefix, `${version}-bun-linux-x64`, "ocx");
    expect(yield* host.install(null, "2.93.0")).toBe(true);
    expect(yield* world.fs.realPath(world.launcher)).toBe(release("2.93.0"));
    // Rollback reuses the retained release directory without downloading it again.
    expect(yield* host.install(null, "2.92.0")).toBe(true);
    expect(yield* world.fs.realPath(world.launcher)).toBe(release("2.92.0"));
    expect(world.downloads).toEqual([urlOf("2.92.0"), urlOf("2.93.0")]);
    expect(restarts).toEqual([
      `${world.path.join(world.home, ".local", "bin", "ocx")} restart`,
      `${world.path.join(world.home, ".local", "bin", "ocx")} restart`,
    ]);
    // An unpinned version, an install GOAT does not own, or a remote without a provisioned
    // runtime changes nothing.
    expect(yield* host.install(null, "2.94.0")).toBe(false);
    yield* world.fs.remove(
      world.path.join(world.prefix, "2.92.0-bun-linux-x64", ".goat-install.json"),
    );
    expect(yield* host.install(null, "2.93.0")).toBe(false);
    expect(yield* world.fs.realPath(world.launcher)).toBe(release("2.92.0"));
    expect(yield* host.install("lidge-ts", "2.93.0")).toBe(false);
    expect(remoteScripts).toEqual([]);
    expect(restarts).toHaveLength(2);
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

it.effect("uses bounded contract, plan and apply arguments through the OpenCodex host seam", () =>
  Effect.gen(function* () {
    const calls: Array<ProcessRunner.ProcessRunInput> = [];
    let remoteOutput = "";
    const planJson =
      '{"schema":"ocx.update.plan/1","currentVersion":"2.89.0","targetVersion":"2.90.0","installer":"external","canApply":true,"planToken":"abcdefghijklmnop","updateInFlight":false,"mutationBoundMs":900000,"servingPath":null,"cliPath":"/bin/ocx"}';
    const resultJson =
      '{"schema":"ocx.update.result/1","applied":true,"toVersion":"2.90.0","healthy":true,"rolledBack":false}';
    const context = yield* Layer.build(
      UpdateHost.layerHost.pipe(
        Layer.provide(
          Layer.mock(Inventory.OpenCodexInventory)({
            read: Effect.succeed({
              ...fleetSnapshot("home"),
              binaries: [{ path: "/bin/ocx", version: "2.89.0" }],
            }),
          }),
        ),
        Layer.provide(Layer.mock(HubParity.HubParity)({})),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(Layer.mock(RuntimeAdmission.RuntimeAdmission)({})),
        Layer.provide(Layer.mock(HostThreads.HostThreadsMcpService)({})),
        Layer.provide(Layer.mock(Installation.OpenCodexInstallation)({})),
        Layer.provide(
          Layer.mock(Dispatch.SshRemoteDispatch)({
            runHostScript: () => Effect.sync(() => ({ stdout: remoteOutput, stderr: "" })),
          }),
        ),
        Layer.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: (input) =>
              Effect.sync(() => {
                calls.push(input);
                const stdout =
                  input.args[0] === "capabilities"
                    ? '{"contracts":["update.orchestrated/1"]}'
                    : input.args.includes("--plan")
                      ? planJson
                      : resultJson;
                return {
                  code: ChildProcessSpawner.ExitCode(0),
                  stdout,
                  stderr: "",
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
          }),
        ),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(HostProcess.Environment, {})),
        Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/")),
      ),
    );
    const host = yield* UpdateHost.OpenCodexUpdateHost.pipe(Effect.provideContext(context));
    expect((yield* host.orchestratedPlan(null, "2.90.0")).kind).toBe("plan");
    expect(yield* host.applyOrchestrated(null, "2.90.0", "abcdefghijklmnop", 123)).toBe("applied");
    expect(
      calls.map(({ args, timeout, maxOutputBytes }) => ({ args, timeout, maxOutputBytes })),
    ).toEqual([
      { args: ["capabilities", "--contracts", "--json"], timeout: 30000, maxOutputBytes: 65536 },
      {
        args: ["update", "--plan", "--json", "--version", "2.90.0"],
        timeout: 60000,
        maxOutputBytes: 65536,
      },
      {
        args: [
          "update",
          "--yes",
          "--json",
          "--version",
          "2.90.0",
          "--expect-plan",
          "abcdefghijklmnop",
          "--not-after",
          "123",
        ],
        timeout: 900000,
        maxOutputBytes: 65536,
      },
    ]);
    expect(yield* host.applyOrchestrated("child", "2.90.0", "abcdefghijklmnop", 123)).toBe(
      "uncertain",
    );
    remoteOutput = `${resultJson}\n__goat_ocx_exit=0\n`;
    expect(yield* host.applyOrchestrated("child", "2.90.0", "abcdefghijklmnop", 123)).toBe(
      "applied",
    );
  }),
);
