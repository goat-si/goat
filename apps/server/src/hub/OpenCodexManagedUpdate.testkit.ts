import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type HubParityResult,
  type OpenCodexInventorySnapshot,
  type OpenCodexSyncReport,
  type OpenCodexUpdateStatus,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { SshRuntimeAutoUpdate } from "../cloud/sshRuntimeAutoUpdate.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Settings from "../serverSettings.ts";
import * as HubParity from "./HubParity.ts";
import * as ManagedUpdate from "./OpenCodexManagedUpdate.ts";
import { OpenCodexSync } from "./OpenCodexSync.ts";
import * as UpdateHost from "./OpenCodexUpdateHost.ts";
import { fleetSnapshot } from "./parity.testkit.ts";

export const MINUTE = 60_000;
const PUBLISHED_AT = "2026-10-01T00:00:00.000Z";
const PUBLISHED = Date.parse(PUBLISHED_AT);

/** Scripted devices: installs change versions, health and parity follow the script. */
export const makeFleet = (
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
  orchestrated: false,
  applyResult: "applied" as "applied" | "refused" | "rolled-back" | "uncertain",
  inFlight: false,
  syncHolding: false,
  planToken: "abcdefghijklmnop",
  servingPath: "/bin/ocx",
  cliPath: "/bin/ocx",
  applyCalls: 0,
  onApply: undefined as Effect.Effect<void> | undefined,
  applyOverride: undefined as
    | ((
        alias: string | null,
        version: string,
        token: string,
        notAfter: number,
      ) => Effect.Effect<"applied" | "refused" | "rolled-back" | "uncertain">)
    | undefined,
  planReads: 0,
  onPlan: undefined as Effect.Effect<void> | undefined,
  planInFlight: [] as boolean[],
  changedOnRead: undefined as "token" | "servingPath" | "cliPath" | undefined,
  planMode: "plan" as "plan" | "none" | "unknown",
  runtimeReplaced: undefined as string | undefined,
  automatic: false,
  childRole: false,
  /** Installs and syncs in the order they ran, as `install:<member>` and `sync:<member>@<version>`. */
  log: [] as Array<string>,
  /** Members whose sync restarts their runtime, as a Child's can after applying Home settings. */
  syncRestarts: new Set<string | null>(),
  syncFails: new Set<string | null>(),
  onSync: undefined as Effect.Effect<void> | undefined,
  syncReport: undefined as OpenCodexSyncReport | undefined,
  /** What the managed update last told the sync about its window. */
  updating: undefined as boolean | undefined,
  /** Hosts that cannot hold turn admission, and how many holds are open right now. */
  noAdmission: new Set<string | null>(),
  holds: 0,
  homeHolds: 0,
  homeHoldCalls: 0,
  exclusiveDepth: 0,
  exclusiveDuringSync: [] as number[],
  holdsDuringSync: [] as number[],
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
export type Fleet = ReturnType<typeof makeFleet>;

const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("Missing fleet fixture value");
  return value;
};

const snapshotOf = (fleet: Fleet, alias: string | null): OpenCodexInventorySnapshot => {
  const base = fleetSnapshot(alias === null ? "home" : "mac-studio");
  const version = required(fleet.versions.get(alias));
  return {
    ...base,
    ownership: required(fleet.ownership.get(alias)),
    service: { available: true, installed: true, running: true, backend: "launchd" },
    runtime: {
      ...base.runtime,
      version,
      healthy: !fleet.unhealthyAt.has(`${alias ?? "home"}@${version}`),
    },
    parityEvidence: {
      ...required(base.parityEvidence),
      startedAt: required(fleet.startedAt.get(alias)),
      processId: required(fleet.processId.get(alias)),
    },
    link: {
      ...base.link,
      role: fleet.childRole && alias === null ? "child" : base.link.role,
      links: base.link.links.filter((link) => link.alias === "mac-studio"),
    },
  };
};

const build = (
  fleet: Fleet,
  baseDir: string,
  fs: FileSystem.FileSystem,
  scheduler?: Scheduler.Scheduler["Service"],
) =>
  Layer.build(
    ManagedUpdate.layerService.pipe(
      Layer.provide(
        Layer.succeed(OpenCodexSync, {
          plan: () => Effect.die("A window never plans a manual sync."),
          run: () => Effect.die("A window never runs a manual sync."),
          latest: Effect.sync(() => fleet.syncReport),
          lastUpdate: Effect.sync(() => fleet.syncReport),
          changes: Stream.empty,
          markUpdating: (open) =>
            Effect.sync(() => {
              fleet.updating = open;
            }),
          exclusive: (body) =>
            Effect.sync(() => {
              fleet.exclusiveDepth++;
            }).pipe(
              Effect.andThen(body),
              Effect.ensuring(
                Effect.sync(() => {
                  fleet.exclusiveDepth--;
                }),
              ),
            ),
          beginUpdate: (targetVersion) =>
            Effect.sync(() => {
              fleet.syncReport = { trigger: "update", checkedAt: 0, targetVersion, members: [] };
            }),
          syncUpdatedMember: (alias) =>
            (fleet.onSync ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  fleet.holdsDuringSync.push(fleet.homeHolds);
                  fleet.exclusiveDuringSync.push(fleet.exclusiveDepth);
                  fleet.log.push(`sync:${alias ?? "home"}@${fleet.versions.get(alias)}`);
                  if (fleet.syncRestarts.has(alias)) {
                    fleet.startedAt.set(alias, required(fleet.startedAt.get(alias)) + 5 * 60_000);
                    fleet.processId.set(alias, required(fleet.processId.get(alias)) + 1);
                  }
                  const updating = fleet.inFlight;
                  const failed = fleet.syncFails.has(alias);
                  fleet.syncHolding = !updating;
                  fleet.syncReport = {
                    ...required(fleet.syncReport),
                    members: [
                      ...required(fleet.syncReport).members,
                      {
                        alias,
                        state: updating ? "skipped" : failed ? "failed" : "synced",
                        restartCodex: !updating,
                        ...(updating ? { reason: "updating" } : failed ? { reason: "exit-1" } : {}),
                      },
                    ],
                  };
                  fleet.syncHolding = false;
                }),
              ),
            ),
        }),
      ),
      Layer.provide(
        Layer.succeed(UpdateHost.OpenCodexUpdateHost, {
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
          orchestratedPlan: (alias, version) =>
            (fleet.onPlan ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  fleet.planReads++;
                  fleet.planInFlight.push(fleet.inFlight);
                  if (!fleet.orchestrated || fleet.planMode === "none")
                    return { kind: "none" as const };
                  if (fleet.planMode === "unknown") return { kind: "unknown" as const };
                  const changed = fleet.planReads > 1 ? fleet.changedOnRead : undefined;
                  return {
                    kind: "plan" as const,
                    plan: {
                      currentVersion: fleet.versions.get(alias) ?? "",
                      targetVersion: version,
                      canApply: true,
                      planToken: changed === "token" ? "different-token-1234" : fleet.planToken,
                      updateInFlight: fleet.inFlight,
                      mutationBoundMs: 900_000,
                      servingPath: changed === "servingPath" ? "/other" : fleet.servingPath,
                      cliPath: changed === "cliPath" ? "/other" : fleet.cliPath,
                    },
                  };
                }),
              ),
            ),
          applyOrchestrated: (alias, version, token, notAfter) =>
            Effect.gen(function* () {
              fleet.applyCalls++;
              if (fleet.applyOverride)
                return yield* fleet.applyOverride(alias, version, token, notAfter);
              if (fleet.onApply) yield* fleet.onApply;
              if (
                (yield* Clock.currentTimeMillis) > notAfter ||
                token !== fleet.planToken ||
                fleet.inFlight ||
                fleet.syncHolding
              )
                return "refused" as const;
              if (fleet.applyResult === "uncertain") fleet.inFlight = true;
              if (fleet.applyResult === "applied") {
                fleet.versions.set(alias, version);
                fleet.processId.set(alias, (fleet.processId.get(alias) ?? 0) + 1);
                fleet.startedAt.set(alias, (fleet.startedAt.get(alias) ?? 0) + 60_000);
              }
              return fleet.applyResult;
            }),
          install: (alias, version) =>
            Effect.sync(() => {
              const key = `${alias ?? "home"}@${version}`;
              fleet.installs.push(key);
              fleet.log.push(`install:${alias ?? "home"}`);
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
              if (alias === null) {
                fleet.homeHolds += 1;
                fleet.homeHoldCalls += 1;
              }
              return true;
            }),
          releaseAdmission: (alias) =>
            Effect.sync(() => {
              fleet.holds -= 1;
              if (alias === null) fleet.homeHolds -= 1;
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
            automaticServerUpdates: fleet.automatic,
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
      Layer.provide(
        scheduler === undefined
          ? Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void })
          : Layer.succeed(Scheduler.Scheduler, scheduler),
      ),
      Layer.provide(
        Layer.mock(SshRuntimeAutoUpdate)({
          supported: true,
          replacedInto: Effect.sync(() => fleet.runtimeReplaced),
        }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
    ),
  );

export const service = Effect.fn("OpenCodexManagedUpdateTest.service")(function* (
  fleet: Fleet,
  baseDir: string,
  scheduler?: Scheduler.Scheduler["Service"],
  customFs?: FileSystem.FileSystem,
) {
  const fs = yield* FileSystem.FileSystem;
  const context = yield* build(fleet, baseDir, customFs ?? fs, scheduler);
  return yield* ManagedUpdate.OpenCodexManagedUpdate.pipe(Effect.provideContext(context));
});

export const setup = Effect.fn("OpenCodexManagedUpdateTest.setup")(function* (
  fleet = makeFleet(),
  customFs?: FileSystem.FileSystem,
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-opencodex-update-" });
  // Long past the stable soak and rollout window, so every bucket is open.
  yield* TestClock.setTime(PUBLISHED + 10 * 24 * 60 * MINUTE);
  return { fleet, baseDir, update: yield* service(fleet, baseDir, undefined, customFs) };
});

export const phases = (status: OpenCodexUpdateStatus | undefined) =>
  status?.members.map(({ alias, phase, reason }) => [alias, phase, reason]);
