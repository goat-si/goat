import {
  CHILD_READY_PROOF_TTL_MS,
  type ChildReadyDeviceResult,
  type ChildReadyPrepareInput,
  type ChildReadyResult,
  type ChildReadyRevision,
  type ChildReadyStep,
  CodexSettings,
  type EnvironmentId,
  type OpenCodexChildSetup,
  type OrchestratorMcpFailure,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ServerSettingsError,
} from "@goat/contracts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Hex from "effect/encoding/Hex";

import * as ServerConfig from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type * as ProcessRunner from "../processRunner.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import { resolveAuthlessManagedRuntime } from "../provider/CodexManagedRuntime.ts";
import * as CodexRoute from "../provider/CodexRouteService.ts";
import * as Settings from "../serverSettings.ts";
import { bootstrapInstanceId } from "./ChildSetupAuthority.ts";
import type * as Journal from "./ChildReadyJournal.ts";
import * as ReadyProbe from "./CodexReadyProbe.ts";
import {
  type ChildStepError,
  childError,
  stepStates,
  withFailure,
  failureFor,
} from "./childReadySetup.ts";
import { localAccountsDigest, readLocalCredentials } from "./OpenCodexLocalAccounts.ts";
import { bindingFailure, type ChildReadyFacts } from "./childReadyBinding.ts";

const decodeCodex = Schema.decodeUnknownEffect(CodexSettings);
const TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

/** A fresh device read with the listener evidence a proof binds to. */
export interface ChildObservation {
  readonly device: ChildReadyDeviceResult;
  readonly port: number;
  readonly listenerInstanceId: string | undefined;
  readonly settingsDigest: string | undefined;
  readonly catalogDigest: string | undefined;
}
type Address = {
  readonly destinationEnvironmentId: EnvironmentId;
  readonly homeEnvironmentId: EnvironmentId;
};
interface LinkedDeps {
  readonly journal: Journal.ChildReadyJournal["Service"];
  readonly routeState: CodexRoute.CodexRouteState["Service"];
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly observe: (address: Address) => Effect.Effect<ChildObservation>;
  readonly authorize: (
    input: ChildReadyPrepareInput,
    scope: McpInvocationScope,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly environment: NodeJS.ProcessEnv;
}
type StageError = ChildStepError | OrchestratorMcpFailure;

/**
 * The post-link stages. Each requires the revision the previous stage returned and checks it
 * again under the settings commit; the Child derives every path, model and instance itself.
 */
export const makeLinkedOperations = Effect.fn("OpenCodexChildReady.makeLinkedOperations")(
  function* (deps: LinkedDeps) {
    const { journal, routeState } = deps;
    const settings = yield* Settings.ServerSettingsService;
    const codex = yield* CodexInstallation.CodexInstallation;
    const readyProbe = yield* ReadyProbe.CodexReadyProbe;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const runtimeContext = yield* Effect.context<
      | CodexInstallation.CodexInstallation
      | ServerConfig.ServerConfig
      | FileSystem.FileSystem
      | Path.Path
      | Crypto.Crypto
    >();
    // One paid request per Home at a time; an identical retry joins it.
    const probes = new Map<
      EnvironmentId,
      {
        readonly operationId: string;
        readonly done: Deferred.Deferred<ChildReadyResult, StageError>;
      }
    >();

    const storage = (step: ChildReadyStep) =>
      Effect.mapError((_: Journal.ChildReadyJournalError) => childError("storage_failed", step));
    const sameRevision = (expected: ChildReadyRevision | undefined) => {
      const current = routeState.revision();
      return (
        expected !== undefined &&
        expected.epoch === current.epoch &&
        expected.sequence === current.sequence
      );
    };
    const requireRevision = (expected: ChildReadyRevision | undefined, step: ChildReadyStep) =>
      sameRevision(expected) ? Effect.void : Effect.fail(childError("stale_configuration", step));
    const storedInstance = (id: ReturnType<typeof bootstrapInstanceId>, step: ChildReadyStep) =>
      settings.getSettings.pipe(
        Effect.map((current) => current.providerInstances[id]),
        Effect.mapError(() => childError("storage_failed", step)),
      );
    const operationFor = Effect.fn("OpenCodexChildReady.operationFor")(function* (
      input: ChildReadyPrepareInput,
      step: ChildReadyStep,
    ) {
      const operation = yield* journal.read(input.homeEnvironmentId).pipe(storage(step));
      if (operation?.operationId !== input.operationId || operation.setup === undefined)
        return yield* childError("stale_configuration", step);
      return { ...operation, setup: operation.setup };
    });
    /** The live link this Child is a client of; anything else stops the stage. */
    const requireLink = Effect.fn("OpenCodexChildReady.requireLink")(function* (
      input: Address,
      step: ChildReadyStep,
    ) {
      const observed = yield* deps.observe(input);
      const { device } = observed.device;
      if (
        !observed.device.healthy ||
        device.connection.role !== "client" ||
        device.connection.linkId === undefined ||
        device.ocx.path === null
      )
        return yield* childError("link_changed", step);
      return { ...observed, linkId: device.connection.linkId, ocxPath: device.ocx.path };
    });
    const digestText = (text: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.map(Hex.encode));
    const desiredFor = (home: EnvironmentId, port: number): ProviderInstanceConfig => {
      const id = bootstrapInstanceId(home);
      return {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex via OpenCodex Home",
        enabled: true,
        environment: [],
        config: {
          setupMode: "managed",
          modelRoute: "opencodex",
          opencodexAuth: "none",
          opencodexBaseUrl: `http://127.0.0.1:${port}/v1`,
          homePath: path.join(config.stateDir, "providers", "codex", id, "home"),
          shadowHomePath: path.join(config.stateDir, "providers", "codex", id, "shadow"),
        },
      };
    };
    const settingsOf = (instance: ProviderInstanceConfig, step: ChildReadyStep) =>
      decodeCodex({ ...(instance.config as object), enabled: instance.enabled !== false }).pipe(
        Effect.mapError(() => childError("route_unverified", step)),
      );
    const resolveRuntime = Effect.fn("OpenCodexChildReady.resolveRuntime")(function* (
      home: EnvironmentId,
      instance: ProviderInstanceConfig,
      step: ChildReadyStep,
    ) {
      const runtimeSettings = yield* settingsOf(instance, step);
      const environment = yield* mergeProviderInstanceEnvironment(
        instance.environment,
        deps.environment,
      ).pipe(Effect.mapError(() => childError("catalog_sync_failed", step)));
      return yield* resolveAuthlessManagedRuntime({
        settings: runtimeSettings,
        instanceId: bootstrapInstanceId(home),
        environment,
        acquisition: "installed",
      }).pipe(
        Effect.mapError(() => childError("catalog_sync_failed", step)),
        Effect.scoped,
        Effect.provide(runtimeContext),
      );
    });
    const finishStage = Effect.fn("OpenCodexChildReady.finishStage")(function* (
      home: EnvironmentId,
      operation: Journal.ChildReadyOperation,
      step: ChildReadyStep,
    ) {
      const { running: _running, ...rest } = operation;
      yield* journal.put(home, rest).pipe(storage(step));
    });

    /**
     * The stored bootstrap instance as this Home owns it. A missing one after ownership is the
     * user's deletion and is never recreated; an existing one is adopted only when it is exactly
     * the candidate recorded before the settings commit (a crash between commit and journal).
     * Anything else is the user's change.
     */
    const claimOwnership = Effect.fn("OpenCodexChildReady.claimOwnership")(function* (
      home: EnvironmentId,
      operation: Journal.ChildReadyOperation | undefined,
      current: ProviderInstanceConfig | undefined,
      step: ChildReadyStep,
    ) {
      if (operation?.deleted === true) return yield* childError("instance_changed", step);
      if (current === undefined) {
        if (operation?.ownedFingerprint === undefined) return { operation, expected: null };
        yield* journal.put(home, { ...operation, deleted: true }).pipe(storage(step));
        return yield* childError("instance_changed", step);
      }
      const fingerprint = CodexRoute.instanceFingerprint(current);
      if (operation !== undefined && fingerprint === operation.ownedFingerprint)
        return { operation, expected: operation.ownedInstance ?? current };
      if (
        operation !== undefined &&
        operation.ownedFingerprint === undefined &&
        fingerprint === operation.desiredFingerprint
      ) {
        const adopted = { ...operation, ownedFingerprint: fingerprint, ownedInstance: current };
        yield* journal.put(home, adopted).pipe(storage(step));
        return { operation: adopted, expected: current };
      }
      return yield* childError("instance_changed", step);
    });

    const installCodex = Effect.fn("OpenCodexChildReady.installCodex")(function* (
      input: ChildReadyPrepareInput,
      scope: McpInvocationScope,
    ) {
      const step = "codex_installed" as const;
      yield* deps.authorize(input, scope);
      yield* requireRevision(input.expectedRevision, step);
      yield* requireLink(input, step);
      const id = bootstrapInstanceId(input.homeEnvironmentId);
      const read = yield* journal.read(input.homeEnvironmentId).pipe(storage(step));
      const current = yield* storedInstance(id, step);
      // A deterministic id this journal never wrote is the user's instance: never adopt it.
      const { operation: previous } = yield* claimOwnership(
        input.homeEnvironmentId,
        read,
        current,
        step,
      );
      const base: Journal.ChildReadyOperation = {
        ...previous,
        operationId: input.operationId,
        homeEnvironmentId: input.homeEnvironmentId,
        destinationEnvironmentId: input.destinationEnvironmentId,
        instanceId: id,
      };
      yield* journal.put(input.homeEnvironmentId, { ...base, running: step }).pipe(storage(step));
      // GOAT's own pinned release, even when another Codex is on PATH; no sign-in.
      yield* codex.resolve({ managedOnly: true }).pipe(
        Effect.catch(() =>
          Effect.gen(function* () {
            const started = yield* codex.startManagedOnly;
            const terminal = TERMINAL.has(started.phase)
              ? started
              : yield* codex.changes.pipe(
                  Stream.filter(
                    (state) =>
                      state.operationId === started.operationId && TERMINAL.has(state.phase),
                  ),
                  Stream.runHead,
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(childError("installation_failed", step)),
                      onSome: Effect.succeed,
                    }),
                  ),
                );
            if (terminal.phase !== "succeeded")
              return yield* childError("installation_failed", step);
            return yield* codex.resolve({ managedOnly: true });
          }),
        ),
        Effect.timeoutOrElse({
          duration: "15 minutes",
          orElse: () => Effect.fail(childError("installation_failed", step)),
        }),
        Effect.mapError((error) =>
          error._tag === "ChildStepError" ? error : childError("installation_failed", step),
        ),
      );
      yield* deps.authorize(input, scope);
      const setup: OpenCodexChildSetup = {
        version: 1,
        operationId: input.operationId,
        destinationEnvironmentId: input.destinationEnvironmentId,
        homeEnvironmentId: input.homeEnvironmentId,
        instanceId: id,
        revision: routeState.revision(),
        steps: stepStates(step, "succeeded"),
        readiness: "linked",
        attribution: "unproven",
        nextAction: "none",
      };
      yield* finishStage(input.homeEnvironmentId, { ...base, setup }, step);
      return { kind: "ok" as const, setup } satisfies ChildReadyResult;
    });

    /**
     * Runs the selected ocx's sync into the bootstrap instance's own effective CODEX_HOME while
     * this Child is a client of its Home, so the catalog is the Home's, never a local fallback.
     */
    const syncCatalog = Effect.fn("OpenCodexChildReady.syncCatalog")(function* (
      input: ChildReadyPrepareInput,
      scope: McpInvocationScope,
    ) {
      const step = "instance_routed" as const;
      yield* deps.authorize(input, scope);
      const operation = yield* operationFor(input, step);
      yield* requireRevision(input.expectedRevision, step);
      const before = yield* requireLink(input, step);
      const desired = desiredFor(input.homeEnvironmentId, before.port);
      const runtime = yield* resolveRuntime(input.homeEnvironmentId, desired, step);
      yield* deps.authorize(input, scope);
      const synced = yield* deps.runner
        .run({
          command: before.ocxPath,
          args: ["sync"],
          env: { ...runtime.environment, CODEX_HOME: runtime.home },
          stdin: "",
          timeout: "60 seconds",
          maxOutputBytes: 64 * 1024,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.mapError(() => childError("catalog_sync_failed", step)));
      if (synced.code !== 0 || synced.timedOut)
        return yield* childError("catalog_sync_failed", step);
      const after = yield* requireLink(input, step);
      if (after.linkId !== before.linkId) return yield* childError("link_changed", step);
      const catalog = yield* fs
        .readFileString(path.join(runtime.home, "opencodex-catalog.json"))
        .pipe(Effect.mapError(() => childError("catalog_sync_failed", step)));
      const setup: OpenCodexChildSetup = {
        ...operation.setup,
        revision: routeState.revision(),
        steps: stepStates(step, "running"),
      };
      yield* journal
        .put(input.homeEnvironmentId, {
          ...operation,
          desiredFingerprint: CodexRoute.instanceFingerprint(desired),
          catalog: {
            home: runtime.home,
            binaryPath: runtime.binaryPath,
            digest: yield* digestText(catalog).pipe(
              Effect.mapError(() => childError("catalog_sync_failed", step)),
            ),
          },
          setup,
        })
        .pipe(storage(step));
      return { kind: "ok" as const, setup } satisfies ChildReadyResult;
    });

    /** Writes the bootstrap instance under the settings lock, then waits for it to hydrate. */
    const configure = Effect.fn("OpenCodexChildReady.configure")(function* (
      input: ChildReadyPrepareInput,
      scope: McpInvocationScope,
    ) {
      const step = "instance_routed" as const;
      yield* deps.authorize(input, scope);
      const operation = yield* operationFor(input, step);
      const catalog = operation.catalog;
      if (catalog === undefined) return yield* childError("catalog_sync_failed", step);
      yield* requireRevision(input.expectedRevision, step);
      const linked = yield* requireLink(input, step);
      const id = bootstrapInstanceId(input.homeEnvironmentId);
      const desired = desiredFor(input.homeEnvironmentId, linked.port);
      if (CodexRoute.instanceFingerprint(desired) !== operation.desiredFingerprint)
        return yield* childError("stale_configuration", step);
      const owned = yield* claimOwnership(
        input.homeEnvironmentId,
        operation,
        yield* storedInstance(id, step),
        step,
      );
      let refusal: "stale_configuration" | "instance_changed" = "instance_changed";
      // The revision is checked again inside the settings lock, and the stored instance must
      // still be exactly what this Home owns (null only on the first create).
      yield* settings
        .updateProviderInstance(
          {
            operation: "upsert",
            instanceId: id,
            instance: desired,
            expectedInstance: owned.expected,
          },
          undefined,
          undefined,
          Effect.suspend(() => {
            const refused = new ServerSettingsError({
              settingsPath: "<child-ready>",
              operation: "normalize",
            });
            if (sameRevision(input.expectedRevision))
              return deps.authorize(input, scope).pipe(Effect.mapError(() => refused));
            refusal = "stale_configuration";
            return Effect.fail(refused);
          }),
        )
        .pipe(Effect.mapError(() => childError(refusal, step)));
      const stored = yield* storedInstance(id, step);
      if (stored === undefined) return yield* childError("instance_changed", step);
      // Settings write first, journal second: a crash between them leaves an exact desired
      // fingerprint to reconcile, never another instance to adopt.
      const runtime = yield* resolveRuntime(input.homeEnvironmentId, stored, step);
      if (runtime.home !== catalog.home || runtime.binaryPath !== catalog.binaryPath)
        return yield* childError("stale_configuration", step);
      const setup: OpenCodexChildSetup = {
        ...operation.setup,
        revision: routeState.revision(),
        steps: stepStates(step, "succeeded"),
      };
      yield* journal
        .put(input.homeEnvironmentId, {
          ...(owned.operation ?? operation),
          ownedFingerprint: CodexRoute.instanceFingerprint(stored),
          ownedInstance: stored,
          setup,
        })
        .pipe(storage(step));
      return { kind: "ok" as const, setup } satisfies ChildReadyResult;
    });

    /** Fresh zero-local-credential attestation from the selected ocx, or an unproven refusal. */
    const attestation = Effect.fn("OpenCodexChildReady.attestation")(function* (
      ocxPath: string,
      step: ChildReadyStep,
    ) {
      const status = yield* readLocalCredentials(deps.runner, ocxPath, deps.environment);
      if (
        Option.isNone(status) ||
        status.value.runtimeRole !== "client" ||
        status.value.localCredentials === undefined ||
        status.value.localCredentials.count !== 0
      )
        return yield* childError("attribution_unproven", step);
      return status.value.localCredentials.generation;
    });

    /** Every fact a proof binds, read now; nothing here starts a request. */
    const currentFacts = Effect.fn("OpenCodexChildReady.currentFacts")(function* (
      observed: ChildObservation,
      instanceId: ReturnType<typeof bootstrapInstanceId>,
      step: ChildReadyStep,
    ) {
      const instance = yield* storedInstance(instanceId, step).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const executable = yield* codex.resolve({ managedOnly: true }).pipe(
        Effect.map((found) => ({ path: found.executablePath, version: found.version })),
        Effect.orElseSucceed(() => undefined),
      );
      const { device } = observed.device;
      const generation =
        device.ocx.path === null
          ? undefined
          : yield* attestation(device.ocx.path, step).pipe(Effect.orElseSucceed(() => undefined));
      return {
        now: yield* Clock.currentTimeMillis,
        device,
        listenerInstanceId: observed.listenerInstanceId,
        settingsDigest: observed.settingsDigest,
        catalogDigest: observed.catalogDigest,
        instance,
        executable,
        localAccountsDigest:
          generation === undefined
            ? undefined
            : yield* localAccountsDigest(crypto, generation).pipe(
                Effect.orElseSucceed(() => undefined),
              ),
      } satisfies ChildReadyFacts;
    });
    // A completed request this process could not record: never repeated for that operation.
    const uncertain = new Set<string>();
    const uncertainKey = (input: ChildReadyPrepareInput) =>
      `${input.homeEnvironmentId}\u0000${input.operationId}`;

    const runProbe = Effect.fn("OpenCodexChildReady.runProbe")(function* (
      input: ChildReadyPrepareInput,
      scope: McpInvocationScope,
    ) {
      const step = "inference_verified" as const;
      const operation = yield* operationFor(input, step);
      const id = bootstrapInstanceId(input.homeEnvironmentId);
      // A proof this operation already earned is answered again while every binding holds.
      const recorded = operation.setup.proof;
      if (recorded !== undefined && recorded.operationId === input.operationId) {
        const facts = yield* currentFacts(yield* deps.observe(input), id, step);
        if (bindingFailure(recorded, facts) === undefined)
          return { kind: "ok" as const, setup: operation.setup } satisfies ChildReadyResult;
      }
      // One paid request per operation: a recorded outcome is answered again, and a request
      // that may have completed unrecorded is never repeated automatically.
      if (operation.probeStarted === true || uncertain.has(uncertainKey(input)))
        return yield* childError(operation.setup.failure?.code ?? "interrupted", step);
      if (operation.catalog === undefined || operation.ownedFingerprint === undefined)
        return yield* childError("route_unverified", step);
      yield* requireRevision(input.expectedRevision, step);
      const instance = yield* storedInstance(id, step);
      if (
        instance === undefined ||
        CodexRoute.instanceFingerprint(instance) !== operation.ownedFingerprint
      )
        return yield* childError("instance_changed", step);
      // Holds the route: a concurrent edit to this instance waits for the check to end.
      yield* routeState
        .reserveUse(id)
        .pipe(Effect.mapError(() => childError("instance_busy", step)));
      const before = yield* requireLink(input, step);
      if (
        before.listenerInstanceId === undefined ||
        before.settingsDigest === undefined ||
        before.catalogDigest === undefined
      )
        return yield* childError("route_unverified", step);
      // Local credentials refuse before any paid request; nothing is deleted.
      const generation = yield* attestation(before.ocxPath, step);
      yield* journal
        .put(input.homeEnvironmentId, {
          ...operation,
          running: step,
          probeStarted: true,
          setup: { ...operation.setup, readiness: "verifying", steps: stepStates(step, "running") },
        })
        .pipe(storage(step));
      yield* deps.authorize(input, scope);
      const result = yield* readyProbe
        .probe({
          instanceId: id,
          settings: yield* settingsOf(instance, step),
          environment: yield* mergeProviderInstanceEnvironment(
            instance.environment,
            deps.environment,
          ).pipe(Effect.mapError(() => childError("route_unverified", step))),
        })
        .pipe(Effect.mapError((error) => childError(error.code, step)));
      // The same link, listener, settings, catalog and credential generation afterwards.
      const after = yield* requireLink(input, step);
      if (after.linkId !== before.linkId || after.listenerInstanceId !== before.listenerInstanceId)
        return yield* childError("link_changed", step);
      if (
        after.settingsDigest !== before.settingsDigest ||
        after.catalogDigest !== before.catalogDigest
      )
        return yield* childError("route_unverified", step);
      if ((yield* attestation(after.ocxPath, step)) !== generation)
        return yield* childError("attribution_unproven", step);
      yield* deps.authorize(input, scope);
      const completedAt = yield* Clock.currentTimeMillis;
      const setup: OpenCodexChildSetup = {
        ...operation.setup,
        revision: routeState.revision(),
        steps: stepStates(step, "succeeded"),
        readiness: "ready",
        attribution: "home_zero_local_accounts",
        nextAction: "none",
        proof: {
          version: 1,
          operationId: input.operationId,
          destinationEnvironmentId: input.destinationEnvironmentId,
          homeEnvironmentId: input.homeEnvironmentId,
          instanceId: id,
          configFingerprint: operation.ownedFingerprint,
          executablePath: result.executablePath,
          executableVersion: result.executableVersion,
          linkId: before.linkId,
          listenerInstanceId: before.listenerInstanceId,
          settingsDigest: before.settingsDigest,
          catalogDigest: before.catalogDigest,
          model: result.model,
          completedAt,
          expiresAt: completedAt + CHILD_READY_PROOF_TTL_MS,
          attribution: "home_zero_local_accounts",
          localAccountsDigest: yield* localAccountsDigest(crypto, generation).pipe(
            Effect.mapError(() => childError("attribution_unproven", step)),
          ),
        },
      };
      const { failure: _failure, ...clean } = setup;
      // Published only when every bound fact still holds against a fresh read.
      if (setup.proof === undefined) return yield* childError("route_unverified", step);
      const broken = bindingFailure(setup.proof, yield* currentFacts(after, id, step));
      if (broken !== undefined) return yield* childError(broken, step);
      const { probeStarted: _started, ...settled } = operation;
      yield* finishStage(input.homeEnvironmentId, { ...settled, setup: clean }, step).pipe(
        Effect.tapError(() => Effect.sync(() => uncertain.add(uncertainKey(input)))),
      );
      return { kind: "ok" as const, setup: clean } satisfies ChildReadyResult;
    });

    /** One request per Home: a matching retry joins it; another operation waits its turn. */
    const probe = Effect.fn("OpenCodexChildReady.probe")(function* (
      input: ChildReadyPrepareInput,
      scope: McpInvocationScope,
    ) {
      yield* deps.authorize(input, scope);
      const running = probes.get(input.homeEnvironmentId);
      if (running !== undefined)
        return running.operationId === input.operationId
          ? yield* Deferred.await(running.done)
          : yield* childError("instance_busy", "inference_verified");
      const done = yield* Deferred.make<ChildReadyResult, StageError>();
      probes.set(input.homeEnvironmentId, { operationId: input.operationId, done });
      return yield* runProbe(input, scope).pipe(
        Effect.scoped,
        Effect.onExit((exit) => Deferred.done(done, exit)),
        Effect.ensuring(Effect.sync(() => probes.delete(input.homeEnvironmentId))),
      );
    });

    /**
     * The recorded setup checked against what is true now, without any request: 24 hours at
     * most, the same link, listener and instance, and zero local credentials. A broken binding
     * is written back as invalid.
     */
    const validatedSetup = Effect.fn("OpenCodexChildReady.validatedSetup")(function* (
      home: EnvironmentId,
      observed: ChildObservation,
    ) {
      const operation = yield* journal.read(home);
      const setup = operation?.setup;
      const proof = setup?.proof;
      if (operation === undefined || setup === undefined || proof === undefined) return setup;
      const step = "inference_verified" as const;
      const code = bindingFailure(proof, yield* currentFacts(observed, proof.instanceId, step));
      if (code === undefined) return setup;
      const invalid = withFailure(setup, failureFor(code, step));
      yield* journal.put(home, { ...operation, setup: invalid });
      return invalid;
    });

    return { installCodex, syncCatalog, configure, probe, validatedSetup };
  },
);
