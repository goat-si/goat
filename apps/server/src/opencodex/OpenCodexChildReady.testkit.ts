import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ChildReadyPrepareInput,
  type ChildReadyResult,
  EnvironmentId,
  type OpenCodexInventorySnapshot,
  OrchestratorMcpFailure,
  type ServerSettings,
  ServerSettingsError,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as UpdateHost from "../hub/OpenCodexUpdateHost.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as CodexRoute from "../provider/CodexRouteService.ts";
import * as Settings from "../serverSettings.ts";
import * as Authority from "./ChildSetupAuthority.ts";
import * as Startup from "./ChildOpenCodexStartup.ts";
import * as Journal from "./ChildReadyJournal.ts";
import * as ReadyProbe from "./CodexReadyProbe.ts";
import * as ChildReady from "./OpenCodexChildReady.ts";
import * as Inventory from "./OpenCodexInventory.ts";
import * as Installation from "./OpenCodexInstallation.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const home = EnvironmentId.make("home-env");
const child = EnvironmentId.make("child-env");
const instanceId = Authority.bootstrapInstanceId(home);
const scope: McpInvocationScope = {
  environmentId: child,
  requestNamespace: "client:setup",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: undefined,
  client: { sessionId: "setup", label: "Home", access: "read-only" },
};
const ok = (stdout = "") =>
  Effect.succeed({
    code: ChildProcessSpawner.ExitCode(0),
    timedOut: false,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });

export interface ChildState {
  role: "standalone" | "client";
  linkId: string;
  listener: string;
  /** The local OpenCodex listener's port, which the bootstrap instance routes to. */
  port: number;
  binary: { path: string; version: string } | undefined;
  localCredentials: { count: number; generation: string } | undefined;
  /** OpenCodex's link connection generation; undefined for a release that does not report it. */
  connectionGeneration: string | undefined;
  revision: { epoch: string; sequence: number };
  managedCodex: boolean;
  installResult: "succeeded" | "failed";
  installFailure: Installation.OpenCodexInstallationError["reason"] | undefined;
  revoked: boolean;
  /** The Home the caller's signed purpose names; another address is refused. */
  purposeHome: EnvironmentId;
  codexVersion: string;
  settingsDigest: string;
  /** Runs inside each `ocx sync` before it writes the catalog; a test may hold one there. */
  duringSync: () => Effect.Effect<void>;
  /** Runs inside each native probe request before it answers; a test may hold one there. */
  duringProbe: () => Effect.Effect<void>;
  /** The bootstrap instance has a hydration or session pending, so its route cannot be held. */
  routeBusy: boolean;
  /** Runs inside each `ocx status` read before it answers; a test may hold one there. */
  duringStatus: () => Effect.Effect<void>;
  /** Wraps each settings commit of a provider instance: hold it, or fail after it lands. */
  commit: (
    write: Effect.Effect<ServerSettings, ServerSettingsError>,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;
}
const snapshotOf = (state: ChildState): OpenCodexInventorySnapshot => ({
  installed: state.binary !== undefined,
  binaries: state.binary === undefined ? [] : [state.binary],
  ownership: state.binary === undefined ? "none" : "managed",
  service: { available: true },
  runtime: {
    port: state.port,
    healthy: state.binary !== undefined,
    ready: true,
    role: state.role,
    ...(state.binary === undefined ? {} : { version: state.binary.version }),
  },
  link: { role: "none", available: true, links: [], childSettingsApplied: null },
  parityEvidence: {
    observedAt: 0,
    healthRole: state.role,
    instanceId: state.listener,
    settingsDigest: state.settingsDigest,
    catalogDigest: "catalog-digest",
    ...(state.role === "client" ? { childLinkId: state.linkId } : {}),
  },
});

/**
 * Production OpenCodexChildReady and journal over boundary doubles: inventory, ocx processes,
 * the Codex installer, the native probe and Home's consent. Settings are the test layer.
 */
export const fixture = Effect.fn("OpenCodexChildReady.testkit.fixture")(function* (
  overrides: Partial<ChildState> = {},
  onProbe: (state: ChildState) => void = () => undefined,
) {
  const state: ChildState = {
    role: "client",
    linkId: "link-1",
    listener: "listener-1",
    port: 10100,
    binary: { path: "/fixture/ocx", version: "2.92.0" },
    localCredentials: { count: 0, generation: "gen-1" },
    connectionGeneration: "connection-1",
    revision: { epoch: "epoch-1", sequence: 1 },
    managedCodex: true,
    installResult: "succeeded",
    installFailure: undefined,
    revoked: false,
    purposeHome: home,
    codexVersion: "0.156.1",
    settingsDigest: "settings-digest",
    commit: (write) => write,
    duringStatus: () => Effect.void,
    duringProbe: () => Effect.void,
    duringSync: () => Effect.void,
    routeBusy: false,
    ...overrides,
  };
  const probes = yield* Ref.make(0);
  const resolveCalls: Array<boolean | undefined> = [];
  const executable = {
    executablePath: "/fixture/codex",
    source: "managed" as const,
    version: "0.156.1",
    managedVersionDirectory: null,
  };
  const installState = (phase: "succeeded" | "failed") => ({
    driver: "codex" as never,
    operationId: null,
    phase,
    downloadedBytes: 0,
    totalBytes: null,
    version: null,
    installedVersion: null,
    canRemove: false,
    message: null,
  });
  const boundary = Layer.mergeAll(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(child),
    }),
    Layer.succeed(Authority.ChildSetupAuthority, {
      authorize: (input) =>
        input.homeEnvironmentId !== state.purposeHome
          ? Effect.fail(
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                reason: "destination_changed",
                message: "another Home",
              }),
            )
          : state.revoked
            ? Effect.fail(
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  reason: "setup_approval_revoked",
                  message: "revoked",
                }),
              )
            : Effect.succeed({ purpose: undefined as never, instanceId }),
    }),
    Layer.mock(Startup.ChildOpenCodexStartup)({ start: () => Effect.void }),
    Layer.mock(Inventory.OpenCodexInventory)({
      readParity: Effect.sync(() => snapshotOf(state)),
    }),
    Layer.mock(Installation.OpenCodexInstallation)({
      install: () =>
        state.installFailure !== undefined
          ? Effect.fail(
              new Installation.OpenCodexInstallationError({ reason: state.installFailure }),
            )
          : Effect.succeed({
              path: "/fixture/ocx",
              realPath: "/fixture/ocx",
              version: "2.92.0",
              ownership: "managed" as const,
            }),
    }),
    Layer.mock(CodexRoute.CodexRouteState)({
      admission: Semaphore.makeUnsafe(1),
      revision: () => state.revision,
      generation: () => "fixture:0",
      assertGeneration: () => Effect.void,
      reserveUse: () =>
        state.routeBusy
          ? Effect.fail(new ServerSettingsError({ settingsPath: "<test>", operation: "normalize" }))
          : Effect.void,
    }),
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "/fixture/managed",
      resolve: (options) => {
        resolveCalls.push(options?.managedOnly);
        return state.managedCodex
          ? Effect.succeed({ ...executable, version: state.codexVersion })
          : Effect.fail(
              new CodexInstallation.CodexInstallationError({
                operation: "resolve",
                detail: "none",
              }),
            );
      },
      acquire: () => Effect.succeed(executable),
      startManagedOnly: Effect.sync(() => {
        if (state.installResult === "succeeded") state.managedCodex = true;
        return installState(state.installResult);
      }),
    }),
    Layer.mock(ProcessRunner.ProcessRunner)({
      run: (input) =>
        Effect.gen(function* () {
          if (input.args[0] === "status") {
            yield* state.duringStatus();
            return yield* ok(
              encodeJson({
                runtimeRole: state.role,
                ...(state.localCredentials === undefined
                  ? {}
                  : { localCredentials: state.localCredentials }),
                ...(state.connectionGeneration === undefined
                  ? {}
                  : { link: { connectionGeneration: state.connectionGeneration } }),
              }),
            );
          }
          if (input.args[0] === "sync") {
            yield* state.duringSync();
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            yield* fs
              .writeFileString(
                path.join(input.env?.CODEX_HOME ?? "", "opencodex-catalog.json"),
                "{}",
              )
              .pipe(Effect.orDie);
          }
          return yield* ok();
        }).pipe(Effect.provide(NodeServices.layer)),
    }),
    Layer.mock(Profiles.PermissionProfiles)({}),
    Layer.mock(UpdateHost.OpenCodexUpdateHost)({}),
    Layer.mock(ReadyProbe.CodexReadyProbe)({
      probe: () =>
        Ref.update(probes, (n) => n + 1).pipe(
          Effect.andThen(Effect.suspend(() => state.duringProbe())),
          Effect.andThen(Effect.sync(() => onProbe(state))),
          Effect.as({
            model: "home-model",
            executablePath: executable.executablePath,
            executableVersion: executable.version,
          }),
        ),
    }),
  );
  // The test settings, with each instance commit passed through `state.commit`.
  const settingsLayer = Layer.effect(
    Settings.ServerSettingsService,
    Effect.map(Settings.ServerSettingsService, (real) =>
      Settings.ServerSettingsService.of({
        ...real,
        updateProviderInstance: (mutation, patch, approval, authorizeAtCommit) =>
          state.commit(real.updateProviderInstance(mutation, patch, approval, authorizeAtCommit)),
      }),
    ),
  ).pipe(Layer.provide(Settings.ServerSettingsService.layerTest()));
  const service = ChildReady.layer.pipe(
    Layer.provideMerge(Journal.layer),
    Layer.provide(boundary),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-child-ready-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const ready = yield* Layer.build(service);
  const run = <A, E>(
    effect: Effect.Effect<A, E, ChildReady.OpenCodexChildReady | Settings.ServerSettingsService>,
  ) => effect.pipe(Effect.provide(ready));
  const call = (
    action: ChildReadyPrepareInput["action"],
    expectedRevision = state.revision,
    operationId = "op-1",
  ): Effect.Effect<ChildReadyResult, OrchestratorMcpFailure> =>
    run(
      Effect.flatMap(ChildReady.OpenCodexChildReady, (service) =>
        service.prepare(
          {
            destinationEnvironmentId: child,
            homeEnvironmentId: home,
            operationId,
            action,
            expectedRevision,
          },
          scope,
        ),
      ),
    );
  const status = run(
    Effect.flatMap(ChildReady.OpenCodexChildReady, (service) =>
      service.status({ destinationEnvironmentId: child, homeEnvironmentId: home }, scope),
    ),
  );
  const storedInstance = run(
    Effect.flatMap(Settings.ServerSettingsService, (settings) =>
      settings.getSettings.pipe(Effect.map((current) => current.providerInstances[instanceId])),
    ),
  );
  const removeInstance = run(
    Effect.flatMap(Settings.ServerSettingsService, (settings) =>
      settings.updateProviderInstance({ operation: "remove", instanceId }),
    ),
  );
  const journal = Context.get(ready, Journal.ChildReadyJournal);
  const seedInstance = run(
    Effect.flatMap(Settings.ServerSettingsService, (settings) =>
      settings.updateSettings({
        providerInstances: { [instanceId]: { driver: "codex" as never, displayName: "Mine" } },
      }),
    ),
  );
  /** installCodex → syncCatalog → configure, the stages before the paid check. */
  const routedAs = (operationId: string) =>
    Effect.gen(function* () {
      for (const action of ["installCodex", "syncCatalog", "configure"] as const) {
        const result = yield* call(action, state.revision, operationId);
        if (result.kind !== "ok") return result;
      }
      return undefined;
    });
  const routed = routedAs("op-1");
  return {
    state,
    call,
    status,
    routed,
    routedAs,
    removeInstance,
    journal,
    storedInstance,
    seedInstance,
    probes: Ref.get(probes),
    resolveCalls,
  };
});

export const failureCode = (result: ChildReadyResult) =>
  result.kind === "error" ? result.failure.code : undefined;
