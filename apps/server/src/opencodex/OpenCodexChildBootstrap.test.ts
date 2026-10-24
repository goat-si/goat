import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type CloudMachineError,
  EnvironmentId,
  type HubDeviceOperationResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as CloudMachines from "../cloudMachines/CloudMachineService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HubMembership from "../hub/HubMembership.ts";
import { type DevicePlatform, HubOcx } from "../hub/HubOcx.ts";
import { fleetSnapshot } from "../hub/parity.testkit.ts";
import * as Settings from "../serverSettings.ts";
import { PREPARE_EXIT } from "./childPrepare.ts";
import * as Bootstrap from "./OpenCodexChildBootstrap.ts";
import * as Inventory from "./OpenCodexInventory.ts";

const MINUTE = 60_000;

interface Machine {
  hub: boolean;
  homeVersion: string;
  platform: DevicePlatform;
  prepareExit: number;
  joined: HubDeviceOperationResult["state"];
  owned: Set<string>;
  /** Machines the cloud catalog no longer counts as this server's: deleted or forgotten. */
  removed: Set<string>;
  /** Link releases the hub holds as pending, which survive a restart. */
  pending: Set<string>;
  revokes: boolean;
  /** Each catalog check and release the bootstrap ran, in order. */
  hubEvents: Queue.Queue<string>;
}

/** Boat, the machine and the Home's OpenCodex as doubles; the bootstrap and its file are real. */
const build = Effect.fn("OpenCodexChildBootstrapTest.build")(function* (
  baseDir: string,
  machine: Machine,
  calls: string[],
) {
  let ready: (alias: string) => Effect.Effect<void> = () => Effect.void;
  let removing: (alias: string) => Effect.Effect<void, CloudMachineError> = () => Effect.void;
  let invalidated: (
    alias: string,
    cause: CloudMachines.CloudAliasInvalidation,
  ) => Effect.Effect<void> = () => Effect.void;
  const context = yield* Layer.build(
    Bootstrap.layer.pipe(
      Layer.provide(
        Layer.mock(CloudMachines.CloudMachineService)({
          onReady: (listener) => Effect.sync(() => void (ready = listener)),
          onRemoving: (listener) => Effect.sync(() => void (removing = listener)),
          onAliasInvalidated: (listener) => Effect.sync(() => void (invalidated = listener)),
          owns: (alias) => Effect.sync(() => machine.owned.has(alias)),
          isRemoved: (alias) =>
            Queue.offer(machine.hubEvents, `removed? ${alias}`).pipe(
              Effect.as(machine.removed.has(alias)),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(HubOcx)({
          devicePlatform: () => Effect.sync(() => machine.platform),
          prepareDevice: (alias, version) =>
            Effect.sync(() => {
              calls.push(`prepare ${alias} ${version}`);
              return {
                code: machine.prepareExit,
                stdout: machine.prepareExit === 0 ? "2.91.0" : "",
              };
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(HubMembership.HubMembership)({
          joinProvisioned: (_scope, alias) =>
            Effect.sync(() => {
              calls.push(`join ${alias}`);
              return {
                deviceAlias: alias,
                action: "join" as const,
                state: machine.joined,
                message: `${alias} is linked to this Home.`,
                steps: [],
              };
            }),
          requestRelease: (alias) => Effect.sync(() => void machine.pending.add(alias)),
          pendingReleases: Effect.sync(() => [...machine.pending]),
          releaseProvisioned: (alias) =>
            Effect.sync(() => {
              if (machine.revokes) machine.pending.delete(alias);
              return {
                deviceAlias: alias,
                action: "leave" as const,
                state: machine.revokes ? ("ready" as const) : ("failed" as const),
                message: "",
                steps: [],
              };
            }).pipe(Effect.tap(() => Queue.offer(machine.hubEvents, `release ${alias}`))),
        }),
      ),
      Layer.provide(
        Layer.mock(Inventory.OpenCodexInventory)({
          read: Effect.sync(() => ({
            ...fleetSnapshot("home"),
            binaries: [{ path: "/usr/local/bin/ocx", version: machine.homeVersion }],
          })),
        }),
      ),
      Layer.provide(
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Effect.sync(() => ({
            ...DEFAULT_SERVER_SETTINGS,
            hub: { ...DEFAULT_SERVER_SETTINGS.hub, enabled: machine.hub },
          })),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("home")),
        }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    ),
  );
  return {
    bootstrap: Context.get(context, Bootstrap.OpenCodexChildBootstrap),
    /** Boat finished readying the machine, as CloudMachineService reports it. */
    ready: (alias: string) => ready(alias),
    /** CloudMachineService is about to delete or forget the machine. */
    removing: (alias: string) => removing(alias),
    invalidated: (alias: string, cause: CloudMachines.CloudAliasInvalidation) =>
      invalidated(alias, cause),
  };
});

const setup = Effect.fn("OpenCodexChildBootstrapTest.setup")(function* (
  overrides: Partial<Machine> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-child-bootstrap-" });
  const machine: Machine = {
    hub: true,
    homeVersion: "2.91.0",
    platform: "posix",
    prepareExit: 0,
    joined: "child",
    owned: new Set(["boat-builder"]),
    removed: new Set(),
    pending: new Set(),
    revokes: true,
    hubEvents: yield* Queue.unbounded<string>(),
    ...overrides,
  };
  const calls: string[] = [];
  return { machine, calls, baseDir, ...(yield* build(baseDir, machine, calls)) };
});

it.layer(NodeServices.layer)("OpenCodex Child bootstrap", (it) => {
  it.effect("a readied cloud machine gets this Home's OpenCodex and joins as its Child, once", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      yield* home.ready("boat-builder");
      // A second readying while the first job runs joins it.
      yield* home.ready("boat-builder");
      expect((yield* home.bootstrap.ensure("boat-builder"))?.state).toBe("child");
      expect(home.calls).toEqual(["prepare boat-builder 2.91.0", "join boat-builder"]);
      expect(yield* home.bootstrap.status("boat-builder")).toMatchObject({
        state: "child",
        version: "2.91.0",
      });
      // Readied again later, as every use does: a Child is left alone.
      yield* home.ready("boat-builder");
      expect((yield* home.bootstrap.status("boat-builder"))?.state).toBe("child");
      // A GOAT restart reads the same outcome back.
      const restarted = yield* build(home.baseDir, home.machine, home.calls);
      yield* restarted.ready("boat-builder");
      expect((yield* restarted.bootstrap.status("boat-builder"))?.state).toBe("child");
      expect(home.calls).toHaveLength(2);
    }),
  );

  it.effect("a machine without npm is blocked with that reason and retried after ten minutes", () =>
    Effect.gen(function* () {
      const home = yield* setup({ prepareExit: PREPARE_EXIT.npmMissing });
      expect(yield* home.bootstrap.ensure("boat-builder")).toMatchObject({
        state: "blocked",
        reason: "npm_missing",
      });
      expect(home.calls).toEqual(["prepare boat-builder 2.91.0"]);
      yield* home.ready("boat-builder");
      expect((yield* home.bootstrap.status("boat-builder"))?.state).toBe("blocked");
      home.machine.prepareExit = 0;
      yield* TestClock.adjust(10 * MINUTE);
      yield* home.ready("boat-builder");
      expect((yield* home.bootstrap.status("boat-builder"))?.state).toBe("running");
      expect((yield* home.bootstrap.ensure("boat-builder"))?.state).toBe("child");
    }),
  );

  it.effect("leaves an SSH host this server did not create untouched", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      yield* home.ready("boat-someone-else");
      expect(yield* home.bootstrap.ensure("boat-someone-else")).toBeUndefined();
      expect(home.calls).toEqual([]);
      expect(yield* home.bootstrap.status("boat-someone-else")).toBeUndefined();
    }),
  );

  it.effect("leaves the machine untouched when this server is not a hub", () =>
    Effect.gen(function* () {
      const home = yield* setup({ hub: false });
      yield* home.ready("boat-builder");
      expect(yield* home.bootstrap.ensure("boat-builder")).toBeUndefined();
      expect(home.calls).toEqual([]);
      expect(yield* home.bootstrap.status("boat-builder")).toBeUndefined();
    }),
  );

  it.effect("reports why it stopped instead of installing where a Child cannot run", () =>
    Effect.gen(function* () {
      const windows = yield* setup({ platform: "windows" });
      expect(yield* windows.bootstrap.ensure("boat-builder")).toMatchObject({
        state: "blocked",
        reason: "platform_unsupported",
      });
      const oldHome = yield* setup({ homeVersion: "2.60.0" });
      expect(yield* oldHome.bootstrap.ensure("boat-builder")).toMatchObject({
        state: "blocked",
        reason: "home_unavailable",
      });
      const refused = yield* setup({ joined: "failed" });
      expect(yield* refused.bootstrap.ensure("boat-builder")).toMatchObject({
        state: "blocked",
        reason: "link_failed",
      });
      expect([...windows.calls, ...oldHome.calls]).toEqual([]);
    }),
  );

  it.effect("a stopped machine keeps its setup and link; a removed one releases its link", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      yield* home.bootstrap.ensure("boat-builder");
      yield* home.invalidated("boat-builder", "lifecycle");
      expect((yield* home.bootstrap.status("boat-builder"))?.state).toBe("child");
      expect(home.machine.pending).toEqual(new Set());
      // The release is on record before the catalog lets go of the machine.
      yield* home.removing("boat-builder");
      expect(home.machine.pending).toEqual(new Set(["boat-builder"]));
      home.machine.removed.add("boat-builder");
      yield* home.invalidated("boat-builder", "removed");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("release boat-builder");
      expect(yield* home.bootstrap.status("boat-builder")).toBeUndefined();
      expect(home.machine.pending).toEqual(new Set());
    }),
  );

  it.effect("a failed release is retried after a restart, once the catalog says it is gone", () =>
    Effect.gen(function* () {
      const home = yield* setup({ revokes: false });
      // GOAT stopped before the catalog let go of the machine: the release waits for it.
      yield* home.removing("boat-builder");
      yield* build(home.baseDir, home.machine, home.calls);
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      expect(home.machine.pending).toEqual(new Set(["boat-builder"]));

      home.machine.removed.add("boat-builder");
      yield* home.invalidated("boat-builder", "removed");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("release boat-builder");
      expect(home.machine.pending).toEqual(new Set(["boat-builder"]));

      home.machine.revokes = true;
      yield* build(home.baseDir, home.machine, home.calls);
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("release boat-builder");
      expect(home.machine.pending).toEqual(new Set());
    }),
  );
});
