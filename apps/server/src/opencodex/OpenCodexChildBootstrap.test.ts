import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  CloudMachineError,
  EnvironmentId,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type HubDeviceOperationResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../auth/SessionStore.ts";
import * as CloudMachines from "../cloudMachines/CloudMachineService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HubMembership from "../hub/HubMembership.ts";
import { type DevicePlatform, HubOcx } from "../hub/HubOcx.ts";
import { fleetSnapshot } from "../hub/parity.testkit.ts";
import * as Settings from "../serverSettings.ts";
import type { SshAliasEvent, SshAliasListener } from "../sshRemote/SshAliasEvents.ts";
import * as SshHostSetup from "../sshRemote/SshHostSetup.ts";
import { PREPARE_EXIT } from "./childPrepare.ts";
import * as Bootstrap from "./OpenCodexChildBootstrap.ts";
import * as Inventory from "./OpenCodexInventory.ts";

const MINUTE = 60_000;

const joinResult = (
  alias: string,
  allowed: boolean,
  joined: HubDeviceOperationResult["state"],
) => ({
  deviceAlias: alias,
  action: "join" as const,
  state: allowed ? joined : ("failed" as const),
  message: allowed ? `${alias} is linked to this Home.` : "Permission was withdrawn.",
  steps: [],
});

interface Machine {
  hub: boolean;
  homeVersion: string;
  platform: DevicePlatform;
  prepareExit: number;
  joined: HubDeviceOperationResult["state"];
  owned: Set<string>;
  /** Machines the cloud catalog no longer counts as this server's: deleted or forgotten. */
  removed: Set<string>;
  catalogReadable: boolean;
  /** Link releases the hub holds as pending, which survive a restart. */
  pending: Set<string>;
  revokes: boolean;
  /** Each catalog check and release the bootstrap ran, in order. */
  hubEvents: Queue.Queue<string>;
  autoJoin: boolean;
  /** SSH hosts GOAT set up, by the revision of their config and pinned key. */
  revisions: Map<string, string>;
  revisionReadable: boolean;
  /** Bumped by each Forget, as SshHostSetup does. */
  generations: Map<string, number>;
  /** Live client sessions and their scopes. */
  sessions: Map<string, ReadonlyArray<AuthEnvironmentScope>>;
  /** Past their expiry: still listed while connected, refused by readActiveScopes. */
  expired: Set<string>;
  /** Runs inside the nth authority read, before it answers. */
  duringSessionRead: { readonly at: number; readonly run: Effect.Effect<void> } | undefined;
  /** Runs inside the nth settings read, which can wait on storage, before it answers. */
  duringSettingsRead: { readonly at: number; readonly run: Effect.Effect<void> } | undefined;
  /** Runs while OpenCodex is being prepared on the machine. */
  duringPrepare: Effect.Effect<void>;
}

const PERSON = { kind: "client" as const, sessionId: AuthSessionId.make("person") };

const clientSession = (
  sessionId: string,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): AuthClientSession => ({
  sessionId: AuthSessionId.make(sessionId),
  subject: "person",
  scopes: [...scopes],
  method: "browser-session-cookie",
  client: { deviceType: "desktop" },
  issuedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(86_400_000),
  lastConnectedAt: null,
  connected: true,
  current: false,
});

/** Boat, the machine and the Home's OpenCodex as doubles; the bootstrap and its file are real. */
const build = Effect.fn("OpenCodexChildBootstrapTest.build")(function* (
  baseDir: string,
  machine: Machine,
  calls: string[],
) {
  let ready: (alias: string) => Effect.Effect<void> = () => Effect.void;
  let sshEvent: SshAliasListener = () => Effect.void;
  let sessionReads = 0;
  let settingsReads = 0;
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
              Effect.andThen(
                machine.catalogReadable
                  ? Effect.succeed(machine.removed.has(alias))
                  : Effect.fail(new CloudMachineError({ reason: "storage_failed" })),
              ),
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
            }).pipe(Effect.tap(() => Effect.suspend(() => machine.duringPrepare))),
        }),
      ),
      Layer.provide(
        Layer.mock(HubMembership.HubMembership)({
          // Like HubMembership, each reads its permission once more before linking.
          joinProvisioned: (_scope, alias, gate) =>
            Effect.gen(function* () {
              calls.push(`join ${alias}`);
              return joinResult(alias, yield* gate, machine.joined);
            }),
          joinWithConsent: (_scope, alias, consent) =>
            Effect.gen(function* () {
              const person = yield* consent;
              calls.push(`join ${alias} as ${person?.sessionId ?? "nobody"}`);
              return joinResult(alias, person !== undefined, machine.joined);
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
        Layer.mock(SshHostSetup.SshHostSetup)({
          aliasRevision: (alias) =>
            machine.revisionReadable
              ? Effect.succeed(machine.revisions.get(alias))
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readFileString",
                  }),
                ),
          aliasGeneration: (alias) => Effect.sync(() => machine.generations.get(alias) ?? 0),
          onAlias: (listener) => Effect.sync(() => void (sshEvent = listener)),
        }),
      ),
      Layer.provide(
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "goat_session",
          legacyCookieName: undefined,
          listActive: () =>
            Effect.sync(() =>
              [...machine.sessions].map(([id, scopes]) => clientSession(id, scopes)),
            ),
          readActiveScopes: (sessionId) =>
            Effect.gen(function* () {
              const hook = machine.duringSessionRead;
              if (hook !== undefined && ++sessionReads === hook.at) yield* hook.run;
              const scopes = machine.sessions.get(sessionId);
              if (scopes === undefined || machine.expired.has(sessionId))
                return yield* new SessionStore.UnknownSessionTokenError({ sessionId });
              return scopes;
            }),
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
          getSettings: Effect.gen(function* () {
            const hook = machine.duringSettingsRead;
            if (hook !== undefined && ++settingsReads === hook.at) yield* hook.run;
            return {
              ...DEFAULT_SERVER_SETTINGS,
              hub: {
                ...DEFAULT_SERVER_SETTINGS.hub,
                enabled: machine.hub,
                autoJoinCloudMachines: machine.autoJoin,
              },
            };
          }),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("home")),
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    ),
  );
  return {
    bootstrap: Context.get(context, Bootstrap.OpenCodexChildBootstrap),
    stateDir: Context.get(context, ServerConfig.ServerConfig).stateDir,
    /** Boat finished readying the machine, as CloudMachineService reports it. */
    ready: (alias: string) => ready(alias),
    /** CloudMachineService is about to delete or forget the machine. */
    removing: (alias: string) => removing(alias),
    invalidated: (alias: string, cause: CloudMachines.CloudAliasInvalidation) =>
      invalidated(alias, cause),
    /** SshHostSetup finished a setup, or began a Forget. */
    ssh: (alias: string, event: SshAliasEvent) => sshEvent(alias, event),
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
    catalogReadable: true,
    pending: new Set(),
    revokes: true,
    hubEvents: yield* Queue.unbounded<string>(),
    autoJoin: true,
    revisions: new Map([["lidge-ts", "rev-1"]]),
    revisionReadable: true,
    generations: new Map(),
    sessions: new Map([["person", ["orchestration:operate", "settings:write"]]]),
    expired: new Set(),
    duringSessionRead: undefined,
    duringSettingsRead: undefined,
    duringPrepare: Effect.void,
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

  it.effect("an unreadable catalog holds the release until a start that can read it", () =>
    Effect.gen(function* () {
      const home = yield* setup({ catalogReadable: false });
      yield* home.removing("boat-builder");
      home.machine.removed.add("boat-builder");
      yield* home.invalidated("boat-builder", "removed");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      home.machine.catalogReadable = true;
      yield* build(home.baseDir, home.machine, home.calls);
      // The next event is the restart's own check, so the first start released nothing.
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
      expect(yield* Queue.take(home.machine.hubEvents)).toBe("release boat-builder");
      expect(home.machine.pending).toEqual(new Set());
    }),
  );

  it.effect(
    "keeps joining cloud machines by default; with the cloud switch off GOAT leaves new ones alone",
    () =>
      Effect.gen(function* () {
        const home = yield* setup({ autoJoin: false });
        yield* home.ready("boat-builder");
        expect(yield* home.bootstrap.ensure("boat-builder")).toBeUndefined();
        expect(home.calls).toEqual([]);
        expect(yield* home.bootstrap.status("boat-builder")).toBeUndefined();
      }),
  );

  it.effect("turning the cloud switch off while a machine is prepared stops before the join", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      home.machine.duringPrepare = Effect.sync(() => void (home.machine.autoJoin = false));
      expect(yield* home.bootstrap.ensure("boat-builder")).toBeUndefined();
      expect(home.calls).toEqual(["prepare boat-builder 2.91.0"]);
      expect(yield* home.bootstrap.status("boat-builder")).toBeUndefined();
    }),
  );

  it.effect(
    "the cloud switch stops only new joins: a Child stays and a removed one still releases",
    () =>
      Effect.gen(function* () {
        const home = yield* setup();
        expect((yield* home.bootstrap.ensure("boat-builder"))?.state).toBe("child");
        home.machine.autoJoin = false;
        yield* home.ready("boat-builder");
        expect((yield* home.bootstrap.status("boat-builder"))?.state).toBe("child");
        yield* home.removing("boat-builder");
        home.machine.removed.add("boat-builder");
        yield* home.invalidated("boat-builder", "removed");
        expect(yield* Queue.take(home.machine.hubEvents)).toBe("removed? boat-builder");
        expect(yield* Queue.take(home.machine.hubEvents)).toBe("release boat-builder");
        expect(home.machine.pending).toEqual(new Set());
      }),
  );

  it.effect("an SSH host GOAT set up stays standalone until a person opts it in", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      yield* home.ssh("lidge-ts", "ready");
      expect(yield* home.bootstrap.ensure("lidge-ts")).toBeUndefined();
      expect(home.calls).toEqual([]);
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
      // Cloud machines follow the hub's switch, and hosts GOAT did not set up have no switch.
      expect(yield* home.bootstrap.sshOptIn("boat-builder")).toBeUndefined();
      expect(yield* home.bootstrap.sshOptIn("from-ssh-config")).toBeUndefined();
    }),
  );

  it.effect("an opted-in SSH host joins on the person's consent now and after setups, once", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect((yield* home.bootstrap.ensure("lidge-ts"))?.state).toBe("child");
      expect(home.calls).toEqual(["prepare lidge-ts 2.91.0", "join lidge-ts as person"]);
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(true);
      // Every later setup readies the host again: a Child is left alone.
      yield* home.ssh("lidge-ts", "ready");
      expect((yield* home.bootstrap.status("lidge-ts"))?.state).toBe("child");
      // The consent outlives a GOAT restart.
      const restarted = yield* build(home.baseDir, home.machine, home.calls);
      expect(yield* restarted.bootstrap.sshOptIn("lidge-ts")).toBe(true);
      expect(home.calls).toHaveLength(2);
    }),
  );

  it.effect("only a live client session with settings:write can opt a host in", () =>
    Effect.gen(function* () {
      const home = yield* setup({ sessions: new Map([["reader", ["orchestration:read"]]]) });
      const agent = {
        kind: "mcp" as const,
        scope: {
          environmentId: EnvironmentId.make("home"),
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
          requestNamespace: "agent",
          thread: undefined,
          client: { sessionId: "agent", label: "Agent", access: "full-access" as const },
          grantedScopes: ["settings:write" as const],
        },
      };
      const reader = { kind: "client" as const, sessionId: AuthSessionId.make("reader") };
      for (const caller of [agent, reader, PERSON]) {
        const refused = yield* home.bootstrap
          .setSshOptIn("lidge-ts", true, caller)
          .pipe(Effect.flip);
        expect(refused._tag).toBe("EnvironmentAuthorizationError");
      }
      home.machine.sessions.set("person", ["settings:write"]);
      for (const alias of ["boat-builder", "from-ssh-config", "../lidge-ts"]) {
        const refused = yield* home.bootstrap.setSshOptIn(alias, true, PERSON).pipe(Effect.flip);
        expect(refused).toMatchObject({ code: "invalid_request" });
      }
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
      expect(home.calls).toEqual([]);
    }),
  );

  it.effect("opting out while the host is prepared stops the join; opting out never unlinks", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      home.machine.duringPrepare = home.bootstrap
        .setSshOptIn("lidge-ts", false, PERSON)
        .pipe(Effect.orDie);
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect(yield* home.bootstrap.ensure("lidge-ts")).toBeUndefined();
      expect(home.calls).toEqual(["prepare lidge-ts 2.91.0"]);
      expect(yield* home.bootstrap.status("lidge-ts")).toBeUndefined();

      home.machine.duringPrepare = Effect.void;
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect((yield* home.bootstrap.ensure("lidge-ts"))?.state).toBe("child");
      yield* home.bootstrap.setSshOptIn("lidge-ts", false, PERSON);
      // Nothing ran to remove the link: membership is a person's to end with Leave.
      expect(home.calls.slice(1)).toEqual(["prepare lidge-ts 2.91.0", "join lidge-ts as person"]);
      expect((yield* home.bootstrap.status("lidge-ts"))?.state).toBe("child");
    }),
  );

  it.effect("a session that loses its access ends the consent, and the host says why", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      home.machine.duringPrepare = Effect.sync(() => void home.machine.sessions.delete("person"));
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect(yield* home.bootstrap.ensure("lidge-ts")).toMatchObject({
        state: "blocked",
        reason: "consent_revoked",
      });
      expect(home.calls).toEqual(["prepare lidge-ts 2.91.0"]);
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
    }),
  );

  it.effect(
    "SSH settings GOAT cannot read block one attempt and keep the consent for the next",
    () =>
      Effect.gen(function* () {
        const home = yield* setup();
        home.machine.duringPrepare = Effect.sync(
          () => void (home.machine.revisionReadable = false),
        );
        yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
        expect(yield* home.bootstrap.ensure("lidge-ts")).toMatchObject({
          state: "blocked",
          reason: "link_failed",
        });
        home.machine.revisionReadable = true;
        expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(true);
        home.machine.duringPrepare = Effect.void;
        expect((yield* home.bootstrap.ensure("lidge-ts"))?.state).toBe("child");
      }),
  );

  it.effect(
    "a Forget ends the consent at once and for good, even while the host's files stay",
    () =>
      Effect.gen(function* () {
        const home = yield* setup();
        // SshHostSetup bumps the alias generation, then tells listeners, before any teardown.
        home.machine.duringPrepare = Effect.sync(
          () => void home.machine.generations.set("lidge-ts", 1),
        ).pipe(Effect.andThen(home.ssh("lidge-ts", "forgotten")), Effect.orDie);
        yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
        expect(yield* home.bootstrap.ensure("lidge-ts")).toBeUndefined();
        expect(home.calls).toEqual(["prepare lidge-ts 2.91.0"]);
        expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
        // The files and their revision are unchanged, yet a restart finds no consent.
        const restarted = yield* build(home.baseDir, home.machine, home.calls);
        yield* restarted.ssh("lidge-ts", "ready");
        expect(yield* restarted.bootstrap.sshOptIn("lidge-ts")).toBe(false);
        expect(home.calls).toHaveLength(1);
      }),
  );

  it.effect("a Forget whose consent cannot be cleared on disk stops that Forget", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      yield* home.bootstrap.ensure("lidge-ts");
      const fs = yield* FileSystem.FileSystem;
      // A directory where the next write goes makes that write fail.
      yield* fs.makeDirectory(`${home.stateDir}/opencodex-child-ssh-consent.json.tmp`);
      const refused = yield* home.ssh("lidge-ts", "forgotten").pipe(Effect.flip);
      expect(refused.code).toBe("orchestration_error");
      // This process stopped using it all the same.
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
      const refusedGrant = yield* home.bootstrap
        .setSshOptIn("lidge-ts", true, PERSON)
        .pipe(Effect.flip);
      expect(refusedGrant).toMatchObject({ code: "orchestration_error" });
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
    }),
  );

  it.effect("an alias added again does not inherit consent given for the old one", () =>
    Effect.gen(function* () {
      const home = yield* setup({ hub: false });
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      // Not a hub: the consent waits, and nothing runs.
      yield* home.ssh("lidge-ts", "ready");
      expect(home.calls).toEqual([]);
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBeUndefined();
      home.machine.hub = true;
      home.machine.revisions.set("lidge-ts", "rev-2");
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
      yield* home.ssh("lidge-ts", "ready");
      expect(yield* home.bootstrap.ensure("lidge-ts")).toBeUndefined();
      expect(home.calls).toEqual([]);
    }),
  );

  it.effect(
    "consent given again during a setup stops that setup; one under the new consent joins",
    () =>
      Effect.gen(function* () {
        const home = yield* setup();
        home.machine.duringPrepare = Effect.sync(
          () => void (home.machine.duringPrepare = Effect.void),
        ).pipe(Effect.andThen(home.bootstrap.setSshOptIn("lidge-ts", true, PERSON)), Effect.orDie);
        yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
        expect(yield* home.bootstrap.ensure("lidge-ts")).toBeUndefined();
        expect((yield* home.bootstrap.ensure("lidge-ts"))?.state).toBe("child");
        expect(home.calls).toEqual([
          "prepare lidge-ts 2.91.0",
          "prepare lidge-ts 2.91.0",
          "join lidge-ts as person",
        ]);
      }),
  );

  it.effect("a withdrawal or Forget during the last consent read before linking wins", () =>
    Effect.gen(function* () {
      // Authority is read when consent is given, before the setup, after preparing, and last by
      // the join itself under the hub permit; the change lands inside that last read.
      const opted = yield* setup();
      opted.machine.duringSessionRead = {
        at: 4,
        run: opted.bootstrap.setSshOptIn("lidge-ts", false, PERSON).pipe(Effect.orDie),
      };
      yield* opted.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect(yield* opted.bootstrap.ensure("lidge-ts")).toBeUndefined();
      expect(opted.calls).toEqual(["prepare lidge-ts 2.91.0", "join lidge-ts as nobody"]);

      const forgotten = yield* setup();
      forgotten.machine.duringSessionRead = {
        at: 4,
        run: Effect.sync(() => void forgotten.machine.generations.set("lidge-ts", 1)).pipe(
          Effect.andThen(forgotten.ssh("lidge-ts", "forgotten")),
          Effect.orDie,
        ),
      };
      yield* forgotten.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect(yield* forgotten.bootstrap.ensure("lidge-ts")).toBeUndefined();
      expect(forgotten.calls).toEqual(["prepare lidge-ts 2.91.0", "join lidge-ts as nobody"]);
    }),
  );

  it.effect("turning a host off after a failed write succeeds only once it is on disk", () =>
    Effect.gen(function* () {
      const home = yield* setup({ hub: false });
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      const fs = yield* FileSystem.FileSystem;
      const blocker = `${home.stateDir}/opencodex-child-ssh-consent.json.tmp`;
      yield* fs.makeDirectory(blocker);
      for (const _attempt of [1, 2]) {
        const refused = yield* home.bootstrap
          .setSshOptIn("lidge-ts", false, PERSON)
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ code: "orchestration_error" });
      }
      yield* fs.remove(blocker, { recursive: true });
      yield* home.bootstrap.setSshOptIn("lidge-ts", false, PERSON);
      home.machine.hub = true;
      const restarted = yield* build(home.baseDir, home.machine, home.calls);
      expect(yield* restarted.bootstrap.sshOptIn("lidge-ts")).toBe(false);
    }),
  );

  it.effect("an expired session neither gives consent nor keeps it", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      home.machine.expired.add("person");
      const refused = yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON).pipe(Effect.flip);
      expect(refused._tag).toBe("EnvironmentAuthorizationError");
      home.machine.expired.delete("person");
      home.machine.duringPrepare = Effect.sync(() => void home.machine.expired.add("person"));
      yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
      expect(yield* home.bootstrap.ensure("lidge-ts")).toMatchObject({
        state: "blocked",
        reason: "consent_revoked",
      });
      expect(home.calls).toEqual(["prepare lidge-ts 2.91.0"]);
    }),
  );

  it.effect(
    "a signed-out session turns the switch off when the host is next read, and says why",
    () =>
      Effect.gen(function* () {
        const home = yield* setup({ hub: false });
        yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
        home.machine.hub = true;
        expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(true);
        home.machine.sessions.delete("person");
        expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
        expect(yield* home.bootstrap.status("lidge-ts")).toMatchObject({
          state: "blocked",
          reason: "consent_revoked",
        });
        expect(home.calls).toEqual([]);
      }),
  );

  it.effect("a session that ends while the last settings read waits still stops the join", () =>
    Effect.gen(function* () {
      const endings: ReadonlyArray<(machine: Machine) => void> = [
        (machine) => void machine.sessions.delete("person"),
        (machine) => void machine.expired.add("person"),
        (machine) => void machine.sessions.set("person", ["orchestration:operate"]),
      ];
      for (const end of endings) {
        const home = yield* setup();
        // Hub state is read before the setup, after preparing, and last by the join itself.
        home.machine.duringSettingsRead = { at: 3, run: Effect.sync(() => end(home.machine)) };
        yield* home.bootstrap.setSshOptIn("lidge-ts", true, PERSON);
        expect(yield* home.bootstrap.ensure("lidge-ts")).toMatchObject({
          state: "blocked",
          reason: "consent_revoked",
        });
        expect(home.calls).toEqual(["prepare lidge-ts 2.91.0", "join lidge-ts as nobody"]);
      }
    }),
  );
});
