import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type ChildReadyPrepareInput,
  type ChildReadyResult,
  EnvironmentId,
  type OpenCodexInventorySnapshot,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

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

const home = EnvironmentId.make("home-env");
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

interface ChildState {
  role: "standalone" | "client";
  linkId: string;
  listener: string;
  binary: { path: string; version: string } | undefined;
  localCredentials: { count: number; generation: string } | undefined;
  revision: { epoch: string; sequence: number };
  managedCodex: boolean;
  installResult: "succeeded" | "failed";
  installFailure: Installation.OpenCodexInstallationError["reason"] | undefined;
  revoked: boolean;
  /** The Home the caller's signed purpose names; another address is refused. */
  purposeHome: EnvironmentId;
}
const snapshotOf = (state: ChildState): OpenCodexInventorySnapshot => ({
  installed: state.binary !== undefined,
  binaries: state.binary === undefined ? [] : [state.binary],
  ownership: state.binary === undefined ? "none" : "managed",
  service: { available: true },
  runtime: {
    port: 10100,
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
    settingsDigest: "settings-digest",
    catalogDigest: "catalog-digest",
    ...(state.role === "client" ? { childLinkId: state.linkId } : {}),
  },
});

/**
 * Production OpenCodexChildReady and journal over boundary doubles: inventory, ocx processes,
 * the Codex installer, the native probe and Home's consent. Settings are the test layer.
 */
const fixture = Effect.fn("OpenCodexChildReady.test.fixture")(function* (
  overrides: Partial<ChildState> = {},
  onProbe: (state: ChildState) => void = () => undefined,
) {
  const state: ChildState = {
    role: "client",
    linkId: "link-1",
    listener: "listener-1",
    binary: { path: "/fixture/ocx", version: "2.92.0" },
    localCredentials: { count: 0, generation: "gen-1" },
    revision: { epoch: "epoch-1", sequence: 1 },
    managedCodex: true,
    installResult: "succeeded",
    installFailure: undefined,
    revoked: false,
    purposeHome: home,
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
      reserveUse: () => Effect.void,
    }),
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "/fixture/managed",
      resolve: (options) => {
        resolveCalls.push(options?.managedOnly);
        return state.managedCodex
          ? Effect.succeed(executable)
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
          if (input.args[0] === "status")
            return yield* ok(
              JSON.stringify({
                runtimeRole: state.role,
                ...(state.localCredentials === undefined
                  ? {}
                  : { localCredentials: state.localCredentials }),
              }),
            );
          if (input.args[0] === "sync") {
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
          Effect.andThen(Effect.sync(() => onProbe(state))),
          Effect.as({
            model: "home-model",
            executablePath: executable.executablePath,
            executableVersion: executable.version,
          }),
        ),
    }),
  );
  const service = ChildReady.layer.pipe(
    Layer.provide(Journal.layer),
    Layer.provide(boundary),
    Layer.provideMerge(Settings.ServerSettingsService.layerTest()),
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
  const seedInstance = run(
    Effect.flatMap(Settings.ServerSettingsService, (settings) =>
      settings.updateSettings({
        providerInstances: { [instanceId]: { driver: "codex" as never, displayName: "Mine" } },
      }),
    ),
  );
  /** installCodex → syncCatalog → configure, the stages before the paid check. */
  const routed = Effect.gen(function* () {
    for (const action of ["installCodex", "syncCatalog", "configure"] as const) {
      const result = yield* call(action);
      if (result.kind !== "ok") return result;
    }
    return undefined;
  });
  return {
    state,
    call,
    status,
    routed,
    storedInstance,
    seedInstance,
    probes: Ref.get(probes),
    resolveCalls,
  };
});

const failureCode = (result: ChildReadyResult) =>
  result.kind === "error" ? result.failure.code : undefined;

it.layer(NodeServices.layer)("OpenCodexChildReady", (it) => {
  it.effect("installs and checks OpenCodex before any Child link exists", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ role: "standalone" });
      const installed = yield* f.call("installOpenCodex");
      expect(installed).toMatchObject({ kind: "prelink", version: "2.92.0", healthy: true });
      const device = yield* f.call("opencodexHealth");
      expect(device).toMatchObject({
        kind: "device",
        device: { connection: { role: "standalone" } },
      });
      // Post-link stages refuse until joined.
      expect(failureCode(yield* f.call("installCodex"))).toBe("link_changed");
    }),
  );

  it.effect.each([
    ["busy", "installation_failed"],
    ["download", "installation_failed"],
    ["verify", "installation_failed"],
    ["shadowed", "ocx_unusable"],
    ["not-managed", "ocx_unusable"],
    ["unsupported", "platform_unsupported"],
  ] as const)("maps an OpenCodex install %s failure to %s", ([reason, code]) =>
    Effect.gen(function* () {
      const f = yield* fixture({ installFailure: reason, role: "standalone" });
      expect(failureCode(yield* f.call("installOpenCodex"))).toBe(code);
    }),
  );

  it.effect("represents a missing executable with null path and version", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ binary: undefined, role: "standalone" });
      expect(yield* f.status).toMatchObject({
        kind: "device",
        healthy: false,
        device: { ocx: { path: null, version: null, ownership: "missing" } },
      });
    }),
  );

  it.effect(
    "creates one managed auth-none Codex instance without reading provider credentials",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        expect(yield* f.routed).toBeUndefined();
        expect(yield* f.storedInstance).toMatchObject({
          driver: "codex",
          enabled: true,
          config: { setupMode: "managed", modelRoute: "opencodex", opencodexAuth: "none" },
        });
      }),
  );

  it.effect("installs GOAT's managed release on a Child whose PATH already has Codex", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ managedCodex: false });
      expect((yield* f.call("installCodex")).kind).toBe("ok");
      expect(f.resolveCalls.length).toBeGreaterThan(0);
      expect(f.resolveCalls.every((managedOnly) => managedOnly === true)).toBe(true);
    }),
  );

  it.effect("joins an existing installer and refuses failed installation without login", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ managedCodex: false, installResult: "failed" });
      expect(failureCode(yield* f.call("installCodex"))).toBe("installation_failed");
    }),
  );

  it.effect("does not overwrite an unowned deterministic instance", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seedInstance;
      expect(failureCode(yield* f.call("installCodex"))).toBe("instance_changed");
      expect(yield* f.storedInstance).toMatchObject({ displayName: "Mine" });
    }),
  );

  it.effect("rejects a stale configuration revision inside the settings commit", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect((yield* f.call("installCodex")).kind).toBe("ok");
      expect((yield* f.call("syncCatalog")).kind).toBe("ok");
      // A concurrent settings change on the Child moves the revision under the caller.
      const stale = f.state.revision;
      f.state.revision = { ...stale, sequence: stale.sequence + 1 };
      expect(failureCode(yield* f.call("configure", stale))).toBe("stale_configuration");
      expect(yield* f.storedInstance).toBeUndefined();
    }),
  );

  it.effect("withholds Home attribution when local accounts exist", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ localCredentials: { count: 1, generation: "gen-1" } });
      yield* f.routed;
      expect(failureCode(yield* f.call("probe"))).toBe("attribution_unproven");
      expect(yield* f.probes).toBe(0);
    }),
  );

  it.effect("offers an OpenCodex update hint when localCredentials is absent", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ localCredentials: undefined });
      yield* f.routed;
      const result = yield* f.call("probe");
      expect(result).toMatchObject({
        kind: "error",
        failure: {
          code: "attribution_unproven",
          message: expect.stringContaining("Update OpenCodex"),
        },
      });
      expect(yield* f.probes).toBe(0);
    }),
  );

  it.effect("requires zero localCredentials and equal generation before and after inference", () =>
    Effect.gen(function* () {
      const f = yield* fixture({}, (state) => {
        state.localCredentials = { count: 0, generation: "gen-2" };
      });
      yield* f.routed;
      expect(failureCode(yield* f.call("probe"))).toBe("attribution_unproven");
      expect(yield* f.probes).toBe(1);
      expect(yield* f.status).toMatchObject({ setup: { readiness: "invalid" } });
    }),
  );

  it.effect("discards completion when the Child link drops mid-probe", () =>
    Effect.gen(function* () {
      const f = yield* fixture({}, (state) => {
        state.role = "standalone";
      });
      yield* f.routed;
      expect(failureCode(yield* f.call("probe"))).toBe("link_changed");
    }),
  );

  it.effect("expires Ready at 24h without another inference", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      const proved = yield* f.call("probe");
      expect(proved).toMatchObject({ kind: "ok", setup: { readiness: "ready" } });
      expect(yield* f.status).toMatchObject({ setup: { readiness: "ready" } });
      yield* TestClock.adjust("24 hours");
      expect(yield* f.status).toMatchObject({
        setup: { readiness: "invalid", failure: { code: "proof_expired" } },
      });
      expect(yield* f.probes).toBe(1);
    }),
  );

  it.effect("retains membership but invalidates proof after a link change", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      yield* f.call("probe");
      f.state.linkId = "link-2";
      expect(yield* f.status).toMatchObject({
        device: { connection: { role: "client", linkId: "link-2" } },
        setup: { readiness: "invalid", failure: { code: "link_changed" } },
      });
    }),
  );

  it.effect("rejects a revoked destination setup purpose before changing settings", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ revoked: true });
      expect(failureCode(yield* f.call("installCodex"))).toBe("setup_approval_revoked");
      expect(yield* f.storedInstance).toBeUndefined();
    }),
  );

  it.effect("a refused address or a stale operation leaves the recorded proof untouched", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      expect(yield* f.call("probe")).toMatchObject({ kind: "ok", setup: { readiness: "ready" } });
      // A purpose for another Home naming this Home's address is refused and writes nothing.
      f.state.purposeHome = EnvironmentId.make("home-b");
      expect(failureCode(yield* f.call("configure"))).toBe("destination_changed");
      f.state.purposeHome = home;
      // An older operation's failing request cannot invalidate the current one.
      const stale = { ...f.state.revision, sequence: f.state.revision.sequence - 1 };
      expect(failureCode(yield* f.call("configure", stale, "op-old"))).toBe("stale_configuration");
      expect(yield* f.status).toMatchObject({ setup: { readiness: "ready" } });
    }),
  );
});
