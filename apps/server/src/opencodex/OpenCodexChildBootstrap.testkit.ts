import {
  AuthSessionId,
  CHILD_READY_PROOF_TTL_MS,
  type ChildReadyFailure,
  type ChildSetupBinding,
  type ServerSettings,
  DEFAULT_SERVER_SETTINGS,
  CloudMachineError,
  EnvironmentId,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type HubDeviceOperationResult,
  type OpenCodexChildSetup,
  ProviderInstanceId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";

import * as SessionStore from "../auth/SessionStore.ts";
import * as CloudMachines from "../cloudMachines/CloudMachineService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HubMembership from "../hub/HubMembership.ts";
import { makeHubConsentGenerations } from "../hub/hubConsentGenerations.ts";
import { type DevicePlatform, HubOcx } from "../hub/HubOcx.ts";
import { fleetSnapshot } from "../hub/parity.testkit.ts";
import * as Settings from "../serverSettings.ts";
import type { SshAliasEvent, SshAliasListener } from "../sshRemote/SshAliasEvents.ts";
import * as SshHostSetup from "../sshRemote/SshHostSetup.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ReadyDispatch from "./ChildReadyDispatch.ts";
import * as Bootstrap from "./OpenCodexChildBootstrap.ts";
import * as Inventory from "./OpenCodexInventory.ts";

export const MINUTE = 60_000;

const joinResult = (
  alias: string,
  allowed: boolean,
  joined: HubDeviceOperationResult["state"],
) => ({
  deviceAlias: alias,
  action: "join" as const,
  state: allowed ? joined : ("failed" as const),
  message: allowed ? `${alias} is linked to this Home.` : "Permission was withdrawn.",
  steps: allowed ? [{ step: "link_add" as const, outcome: "ok" as const, detail: "r2-link" }] : [],
});

export interface Machine {
  hub: boolean;
  homeVersion: string;
  platform: DevicePlatform;
  /** The Child refuses preparing OpenCodex with this; it prepares when undefined. */
  prepareFailure: ChildReadyFailure["code"] | undefined;
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
  /** Runs inside the nth read of the alias's SSH files, before it answers. */
  duringRevisionRead: { readonly at: number; readonly run: Effect.Effect<void> } | undefined;
  /** A full settings read answers from this captured hub state while it is set. */
  capturedHub: { readonly enabled: boolean; readonly autoJoin: boolean } | undefined;
  /** Runs while OpenCodex is being prepared on the machine. */
  duringPrepare: Effect.Effect<void>;
  /** Whether GOAT's runtime is usable there once the Home ensured it. */
  runtime: boolean;
  /** The Child's own setup after linking: a refusal, or Ready when undefined. */
  completeFailure: ChildReadyFailure | undefined;
  /** Committed settings changes, as ServerSettingsService publishes them. */
  settingsChanges: PubSub.PubSub<ServerSettings>;
  /** The settings subscriber receives published changes only once this completes. */
  deliverChanges: Deferred.Deferred<void>;
  /** serverSettings' own consent generations; `commitHub` advances them like a commit. */
  consent: Effect.Success<typeof makeHubConsentGenerations>;
  /** Runs when the Home revokes a setup binding's Child sessions. */
  onRevoke: (binding: ChildSetupBinding) => Effect.Effect<void>;
  /** Each Child completion the Home asked for, as "alias linkId". */
  completed: string[];
  /** Home link records beyond the fleet fixture's. */
  extraLinks: ReadonlyArray<{ readonly id: string; readonly alias: string }>;
  /** Whether the Child's Ready carries a proof, which Home status then confirms with it. */
  readyProof: boolean;
  /** The Child's own setup as its status reads it; set when it completes. */
  childSetup: OpenCodexChildSetup | undefined;
  /** A status read of the Child fails with this while set. */
  statusFailure: ChildReadyFailure | undefined;
  /** Status reads the Home made of the Child. */
  statusReads: number;
  /** Replaces the Child protocol double with a production dispatch over a transport double. */
  readyDispatch: ReadyDispatch.ChildReadyDispatch["Service"] | undefined;
  /** Runs while the Home ensures GOAT's runtime on the machine. */
  duringEnsure: Effect.Effect<void>;
}

export const PERSON = { kind: "client" as const, sessionId: AuthSessionId.make("person") };

const readySetup = (
  admission: ReadyDispatch.ChildSetupAdmission,
  proof: boolean,
): OpenCodexChildSetup => {
  const { operationId, destinationEnvironmentId, homeEnvironmentId } = admission.binding;
  const instanceId = ProviderInstanceId.make("goat_ocx_0123456789abcdef01234567");
  return {
    version: 1,
    operationId,
    destinationEnvironmentId,
    homeEnvironmentId,
    instanceId,
    revision: { epoch: "e", sequence: 1 },
    steps: [],
    readiness: "ready",
    attribution: "home_zero_local_accounts",
    nextAction: "none",
    ...(proof
      ? {
          proof: {
            version: 1,
            operationId,
            destinationEnvironmentId,
            homeEnvironmentId,
            instanceId,
            configFingerprint: "config",
            executablePath: "/fixture/codex",
            executableVersion: "0.156.0",
            linkId: "r2-link",
            listenerInstanceId: "listener",
            linkConnectionGeneration: "connection",
            settingsDigest: "settings",
            catalogDigest: "catalog",
            model: "fixture-model",
            completedAt: 0,
            expiresAt: CHILD_READY_PROOF_TTL_MS,
            attribution: "home_zero_local_accounts",
            localAccountsDigest: "zero-local",
          },
        }
      : {}),
  };
};
/** The Child's side as typed answers: prepare as the old exit codes said, complete as told. */
const childProtocol = (
  machine: Machine,
  calls: string[],
): ReadyDispatch.ChildReadyDispatch["Service"] => ({
  prepare: (alias, _home, admission) =>
    Effect.gen(function* () {
      calls.push(`prepare ${alias} ${machine.homeVersion}`);
      yield* Effect.suspend(() => machine.duringPrepare);
      if (machine.prepareFailure !== undefined)
        return yield* new ReadyDispatch.ChildReadyDispatchFailure({
          failure: {
            code: machine.prepareFailure,
            step: "opencodex_running",
            message: "OpenCodex could not be prepared there.",
            retryable: true,
          },
        });
      return {
        kind: "device" as const,
        destinationEnvironmentId: admission.binding.destinationEnvironmentId,
        homeEnvironmentId: admission.binding.homeEnvironmentId,
        healthy: true,
        revision: { epoch: "e", sequence: 1 },
        device: {
          platform: "linux",
          arch: "x64",
          ocx: { path: "/fixture/ocx", version: "2.91.0", ownership: "managed" as const },
          connection: { role: "standalone" as const },
        },
      };
    }),
  complete: (alias, _home, admission, linkId) =>
    Effect.suspend(() => {
      machine.completed.push(`${alias} ${linkId}`);
      if (machine.completeFailure !== undefined)
        return Effect.fail(
          new ReadyDispatch.ChildReadyDispatchFailure({ failure: machine.completeFailure }),
        );
      machine.childSetup = readySetup(admission, machine.readyProof);
      return Effect.succeed(machine.childSetup);
    }),
  status: (_alias, admission) =>
    Effect.suspend(() => {
      machine.statusReads++;
      if (machine.statusFailure !== undefined)
        return Effect.fail(
          new ReadyDispatch.ChildReadyDispatchFailure({ failure: machine.statusFailure }),
        );
      return Effect.succeed({
        kind: "device" as const,
        destinationEnvironmentId: admission.binding.destinationEnvironmentId,
        homeEnvironmentId: admission.binding.homeEnvironmentId,
        healthy: true,
        revision: { epoch: "e", sequence: 1 },
        device: {
          platform: "linux",
          arch: "x64",
          ocx: { path: "/fixture/ocx", version: "2.91.0", ownership: "managed" as const },
          connection: { role: "client" as const, linkId: "r2-link" },
        },
        ...(machine.childSetup === undefined ? {} : { setup: machine.childSetup }),
      });
    }),
});

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
export const build = Effect.fn("OpenCodexChildBootstrapTest.build")(function* (
  baseDir: string,
  machine: Machine,
  calls: string[],
) {
  let ready: (alias: string) => Effect.Effect<void> = () => Effect.void;
  let sshEvent: SshAliasListener = () => Effect.void;
  let sessionReads = 0;
  let settingsReads = 0;
  let revisionReads = 0;
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
          ensureDeviceRuntime: () =>
            Effect.suspend(() => machine.duringEnsure).pipe(Effect.as(machine.runtime)),
        }),
      ),
      Layer.provide(
        Layer.succeed(
          ReadyDispatch.ChildReadyDispatch,
          machine.readyDispatch ?? childProtocol(machine, calls),
        ),
      ),
      Layer.provide(
        Layer.mock(Dispatch.SshRemoteDispatch)({
          // Setup must never mint an ordinary MCP session; identity comes over pinned SSH.
          callHostTool: () => Effect.die("Child setup minted an ordinary MCP session"),
          identifyTarget: () => Effect.succeed(EnvironmentId.make("child-env")),
          revokeChildSetupSessions: (binding) => Effect.suspend(() => machine.onRevoke(binding)),
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
              ? Effect.gen(function* () {
                  const hook = machine.duringRevisionRead;
                  if (hook !== undefined && ++revisionReads === hook.at) yield* hook.run;
                  return machine.revisions.get(alias);
                })
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
          read: Effect.sync(() => {
            const snapshot = fleetSnapshot("home");
            return {
              ...snapshot,
              binaries: [{ path: "/usr/local/bin/ocx", version: machine.homeVersion }],
              link: {
                ...snapshot.link,
                links: [
                  ...snapshot.link.links,
                  ...machine.extraLinks.map((link) => ({
                    ...link,
                    tunnelPort: 20000,
                    state: "connected" as const,
                  })),
                ],
              },
            };
          }),
        }),
      ),
      Layer.provide(
        Layer.mock(Settings.ServerSettingsService)({
          // Subscribed at once, delivered only when the test lets the subscriber run.
          subscribeChanges: Effect.map(PubSub.subscribe(machine.settingsChanges), (subscription) =>
            Stream.fromEffect(Deferred.await(machine.deliverChanges)).pipe(
              Stream.flatMap(() => Stream.fromSubscription(subscription)),
            ),
          ),
          hubConsentGenerations: Effect.suspend(() => machine.consent.current),
          // As in serverSettings: a full read can answer from state captured before it waited.
          getSettings: Effect.sync(() => ({
            ...DEFAULT_SERVER_SETTINGS,
            hub: {
              ...DEFAULT_SERVER_SETTINGS.hub,
              enabled: machine.capturedHub?.enabled ?? machine.hub,
              autoJoinCloudMachines: machine.capturedHub?.autoJoin ?? machine.autoJoin,
            },
          })),
          committedHub: Effect.gen(function* () {
            const hook = machine.duringSettingsRead;
            if (hook !== undefined && ++settingsReads === hook.at) yield* hook.run;
            return {
              ...DEFAULT_SERVER_SETTINGS.hub,
              enabled: machine.hub,
              autoJoinCloudMachines: machine.autoJoin,
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

export const setup = Effect.fn("OpenCodexChildBootstrapTest.setup")(function* (
  overrides: Partial<Machine> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-child-bootstrap-" });
  const machine: Machine = {
    hub: true,
    homeVersion: "2.91.0",
    platform: "posix",
    prepareFailure: undefined,
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
    duringRevisionRead: undefined,
    capturedHub: undefined,
    duringPrepare: Effect.void,
    runtime: true,
    duringEnsure: Effect.void,
    completeFailure: undefined,
    settingsChanges: yield* PubSub.unbounded<ServerSettings>(),
    deliverChanges: yield* Deferred.make<void>(),
    consent: yield* makeHubConsentGenerations,
    onRevoke: () => Effect.void,
    completed: [],
    extraLinks: [],
    readyProof: false,
    childSetup: undefined,
    statusFailure: undefined,
    statusReads: 0,
    readyDispatch: undefined,
    ...overrides,
  };
  if (overrides.deliverChanges === undefined)
    yield* Deferred.succeed(machine.deliverChanges, undefined);
  yield* machine.consent.committed({
    enabled: machine.hub,
    autoJoinCloudMachines: machine.autoJoin,
  });
  const calls: string[] = [];
  return { machine, calls, baseDir, ...(yield* build(baseDir, machine, calls)) };
});

/** A settings commit of the hub switches: consent generations advance before anyone is told. */
export const commitHub = Effect.fn("OpenCodexChildBootstrapTest.commitHub")(function* (
  machine: Machine,
  next: { readonly hub?: boolean; readonly autoJoin?: boolean },
) {
  machine.hub = next.hub ?? machine.hub;
  machine.autoJoin = next.autoJoin ?? machine.autoJoin;
  yield* machine.consent.committed({
    enabled: machine.hub,
    autoJoinCloudMachines: machine.autoJoin,
  });
  return {
    ...DEFAULT_SERVER_SETTINGS,
    hub: {
      ...DEFAULT_SERVER_SETTINGS.hub,
      enabled: machine.hub,
      autoJoinCloudMachines: machine.autoJoin,
    },
  };
});
