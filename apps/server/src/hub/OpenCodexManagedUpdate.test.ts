import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type HubParityResult,
  type OpenCodexInventorySnapshot,
  type OpenCodexUpdateStatus,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Settings from "../serverSettings.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HubParity from "./HubParity.ts";
import * as ManagedUpdate from "./OpenCodexManagedUpdate.ts";
import { fleetSnapshot } from "./parity.testkit.ts";

const MINUTE = 60_000;
const PUBLISHED_AT = "2026-10-01T00:00:00.000Z";
const PUBLISHED = Date.parse(PUBLISHED_AT);

/** Scripted devices: installs change versions, health and parity follow the script. */
const makeFleet = (
  overrides: { homeOwnership?: "managed" | "adopted"; childOwnership?: "managed" | "adopted" } = {},
) => ({
  versions: new Map<string | null, string>([
    [null, "2.89.0"],
    ["mac-studio", "2.86.0"],
  ]),
  ownership: new Map<string | null, OpenCodexInventorySnapshot["ownership"]>([
    [null, overrides.homeOwnership ?? "managed"],
    ["mac-studio", overrides.childOwnership ?? "managed"],
  ]),
  running: new Map<string | null, number | undefined>([
    [null, 0],
    ["mac-studio", 0],
  ]),
  installs: [] as Array<string>,
  /** Hosts that cannot hold turn admission, and how many holds are open right now. */
  noAdmission: new Set<string | null>(),
  holds: 0,
  unhealthyAt: new Set<string>(),
  /** Installs of these `alias@version` fail once, as an unreachable host or npm error would. */
  failOnce: new Set<string>(),
  /** Process start per member; an install restarts it, a crash moves it without a version change. */
  startedAt: new Map<string | null, number>([
    [null, 1],
    ["mac-studio", 1],
  ]),
  processId: new Map<string | null, number>([
    [null, 100],
    ["mac-studio", 200],
  ]),
  parity: new Map<string, HubParityResult["verdict"]>([["mac-studio", "ok"]]),
  /** Connection-bound relay auth changes in 2.90.0; a pair on different sides of it is broken. */
  relayAuth: false,
  goatclaw: true,
  hub: true,
});
type Fleet = ReturnType<typeof makeFleet>;

const snapshotOf = (fleet: Fleet, alias: string | null): OpenCodexInventorySnapshot => {
  const base = fleetSnapshot(alias === null ? "home" : "mac-studio");
  const version = fleet.versions.get(alias)!;
  return {
    ...base,
    ownership: fleet.ownership.get(alias)!,
    service: { available: true, installed: true, running: true, backend: "launchd" },
    runtime: {
      ...base.runtime,
      version,
      healthy: !fleet.unhealthyAt.has(`${alias ?? "home"}@${version}`),
    },
    parityEvidence: {
      ...base.parityEvidence!,
      startedAt: fleet.startedAt.get(alias)!,
      processId: fleet.processId.get(alias)!,
    },
    link: {
      ...base.link,
      links: base.link.links.filter((link) => link.alias === "mac-studio"),
    },
  };
};

const build = (fleet: Fleet, baseDir: string) =>
  Layer.build(
    ManagedUpdate.layerService.pipe(
      Layer.provide(
        Layer.succeed(ManagedUpdate.OpenCodexUpdateHost, {
          latestRelease: Effect.succeed({
            version: "2.90.0",
            publishedAt: PUBLISHED_AT,
          }),
          member: (alias) =>
            Effect.sync(() => ({
              alias,
              snapshot: snapshotOf(fleet, alias),
              runningTurns: fleet.running.get(alias),
            })),
          install: (alias, version) =>
            Effect.sync(() => {
              const key = `${alias ?? "home"}@${version}`;
              fleet.installs.push(key);
              if (fleet.failOnce.delete(key)) return false;
              fleet.versions.set(alias, version);
              fleet.startedAt.set(alias, fleet.installs.length * 60_000);
              fleet.processId.set(alias, 1_000 + fleet.installs.length);
              return true;
            }),
          holdAdmission: (alias) =>
            Effect.sync(() => {
              if (fleet.noAdmission.has(alias)) return false;
              fleet.holds += 1;
              return true;
            }),
          releaseAdmission: () =>
            Effect.sync(() => {
              fleet.holds -= 1;
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(HubParity.HubParity)({
          verify: (alias) =>
            Effect.sync(() => ({
              verdict:
                fleet.relayAuth &&
                (fleet.versions.get(alias) === "2.90.0") !== (fleet.versions.get(null) === "2.90.0")
                  ? ("broken" as const)
                  : (fleet.parity.get(alias) ?? "unproven"),
              checkedAt: 0,
              failingCheckIds: [],
              checks: [],
            })),
        }),
      ),
      Layer.provide(
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Effect.sync(() => ({
            ...DEFAULT_SERVER_SETTINGS,
            goatclaw: { ...DEFAULT_SERVER_SETTINGS.goatclaw, enabled: fleet.goatclaw },
            hub: { ...DEFAULT_SERVER_SETTINGS.hub, enabled: fleet.hub },
          })),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("hub-fixture")),
        }),
      ),
      Layer.provide(Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void })),
      Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    ),
  );

const service = Effect.fn("OpenCodexManagedUpdateTest.service")(function* (
  fleet: Fleet,
  baseDir: string,
) {
  const context = yield* build(fleet, baseDir);
  return yield* ManagedUpdate.OpenCodexManagedUpdate.pipe(Effect.provideContext(context));
});

const setup = Effect.fn("OpenCodexManagedUpdateTest.setup")(function* (fleet = makeFleet()) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-opencodex-update-" });
  // Long past the stable soak and rollout window, so every bucket is open.
  yield* TestClock.setTime(PUBLISHED + 10 * 24 * 60 * MINUTE);
  return { fleet, baseDir, update: yield* service(fleet, baseDir) };
});

const phases = (status: OpenCodexUpdateStatus | undefined) =>
  status?.members.map(({ alias, phase, reason }) => [alias, phase, reason]);

it.layer(NodeServices.layer)("OpenCodex managed update", (it) => {
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
        ManagedUpdate.layerHost.pipe(
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
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.succeed(HostProcess.Environment, {})),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/")),
        ),
      );
      const host = yield* ManagedUpdate.OpenCodexUpdateHost.pipe(Effect.provideContext(context));
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
