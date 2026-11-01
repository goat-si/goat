import {
  type ChildReadyAddress,
  type ChildReadyConnectionInput,
  type ChildReadyConnectionResult,
  type ChildReadyDeviceResult,
  type ChildReadyFailure,
  ChildReadyFailureCode,
  type ChildReadyPrepareInput,
  type ChildReadyResult,
  type ChildReadyRevision,
  type ChildReadyStep,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as UpdateHost from "../hub/OpenCodexUpdateHost.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CodexRoute from "../provider/CodexRouteService.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Authority from "./ChildSetupAuthority.ts";
import * as Journal from "./ChildReadyJournal.ts";
import * as Startup from "./ChildOpenCodexStartup.ts";
import { makeChildConnection } from "./childConnection.ts";
import { type ChildObservation, makeLinkedOperations } from "./childReadyLinked.ts";
import {
  ChildStepError,
  childError,
  deviceFromSnapshot,
  failureFor,
  withFailure,
} from "./childReadySetup.ts";
import * as Inventory from "./OpenCodexInventory.ts";
import * as Installation from "./OpenCodexInstallation.ts";

/**
 * The Child side of a Home's setup: install and start OpenCodex before linking, then install
 * Codex, sync the Home catalog, route one bootstrap instance and prove it with one real request.
 * Setup failures are answered as data, so their codes reach the Home intact.
 */
export class OpenCodexChildReady extends Context.Service<
  OpenCodexChildReady,
  {
    readonly prepare: (
      input: ChildReadyPrepareInput,
      scope: McpInvocationScope,
    ) => Effect.Effect<ChildReadyResult, OrchestratorMcpFailure>;
    readonly status: (
      input: ChildReadyAddress,
      scope: McpInvocationScope,
    ) => Effect.Effect<ChildReadyResult, OrchestratorMcpFailure>;
    readonly connection: (
      input: ChildReadyConnectionInput,
      scope: McpInvocationScope,
    ) => Effect.Effect<ChildReadyConnectionResult, OrchestratorMcpFailure>;
  }
>()("goat/opencodex/OpenCodexChildReady") {}

const isFailureCode = Schema.is(ChildReadyFailureCode);
const STEP_OF: Record<ChildReadyPrepareInput["action"], ChildReadyStep> = {
  installOpenCodex: "opencodex_running",
  startOpenCodex: "opencodex_running",
  opencodexHealth: "opencodex_running",
  installCodex: "codex_installed",
  syncCatalog: "instance_routed",
  configure: "instance_routed",
  probe: "inference_verified",
};
const INSTALL_FAILURE: Record<
  Installation.OpenCodexInstallationError["reason"],
  ChildReadyFailure["code"]
> = {
  unsupported: "platform_unsupported",
  busy: "installation_failed",
  download: "installation_failed",
  archive: "installation_failed",
  verify: "installation_failed",
  activation: "installation_failed",
  io: "installation_failed",
  shadowed: "ocx_unusable",
  "not-managed": "ocx_unusable",
};
/**
 * OpenCodex's Windows Remote Link contains the Child's ocx in a job it compiles with Add-Type,
 * which Constrained Language Mode forbids, so every link command there would fail.
 */
const CONSTRAINED_POWERSHELL =
  "Windows PowerShell on this Child does not run in Full Language mode, which OpenCodex Remote Link needs. Allow Full Language mode for this account, then retry setup.";
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/u;

const make = Effect.gen(function* () {
  const destinationEnvironmentId = yield* (yield* Environment.ServerEnvironmentIdentity)
    .getEnvironmentId;
  const authority = yield* Authority.ChildSetupAuthority;
  const journal = yield* Journal.ChildReadyJournal;
  const startup = yield* Startup.ChildOpenCodexStartup;
  const inventory = yield* Inventory.OpenCodexInventory;
  const installer = yield* Installation.OpenCodexInstallation;
  const routeState = yield* CodexRoute.CodexRouteState;
  const runner = yield* ProcessRunner.ProcessRunner;
  const profiles = yield* Profiles.PermissionProfiles;
  const host = yield* UpdateHost.OpenCodexUpdateHost;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const userHome = yield* HostProcess.HomeDirectory;
  const cwd = yield* HostProcess.WorkingDirectory;
  const opencodexHome = environment.OPENCODEX_HOME || `${userHome.replace(/\/+$/u, "")}/.opencodex`;

  const storage = (step: ChildReadyStep) =>
    Effect.mapError((_: Journal.ChildReadyJournalError) => childError("storage_failed", step));

  /** Fresh device evidence plus the route revision read beside it; never a cached answer. */
  const observe = Effect.fn("OpenCodexChildReady.observe")(function* (address: ChildReadyAddress) {
    const snapshot = yield* inventory.readParity;
    const revision: ChildReadyRevision = routeState.revision();
    const observed = deviceFromSnapshot(snapshot, platform, arch);
    const evidence = snapshot.parityEvidence;
    return {
      device: {
        kind: "device" as const,
        ...address,
        device: observed.device,
        healthy: observed.healthy,
        revision,
      } satisfies ChildReadyDeviceResult,
      port: snapshot.runtime.port,
      listenerInstanceId: evidence?.instanceId,
      settingsDigest: evidence?.settingsDigest,
      catalogDigest: evidence?.catalogDigest,
    } satisfies ChildObservation;
  });
  const readDevice = (address: ChildReadyAddress) =>
    observe(address).pipe(Effect.map((observed) => observed.device));

  /** Typed ocx_unusable before installing: a constrained PowerShell cannot carry Remote Link. */
  const fullLanguagePowerShell = Effect.gen(function* () {
    const output = yield* runner
      .run({
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ExecutionContext.SessionState.LanguageMode",
        ],
        env: environment,
        timeout: "20 seconds",
        maxOutputBytes: 4096,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (output?.code === 0 && !output.timedOut && output.stdout.trim() === "FullLanguage") return;
    return yield* new OrchestratorMcpFailure({
      code: "orchestration_error",
      reason: "ocx_unusable",
      message: CONSTRAINED_POWERSHELL,
    });
  });

  const authorize = (
    input: ChildReadyPrepareInput | (ChildReadyAddress & { readonly action: "status" }),
    scope: McpInvocationScope,
  ) => authority.authorize(input, scope).pipe(Effect.asVoid);

  const linked = yield* makeLinkedOperations({
    journal,
    routeState,
    runner,
    observe,
    authorize,
    environment,
  });

  /** Records a stage's failure on the operation; the proof never survives it. */
  const recordFailure = Effect.fn("OpenCodexChildReady.recordFailure")(function* (
    input: ChildReadyPrepareInput,
    failure: ChildReadyFailure,
  ) {
    // Only the authorized Home's current operation, compared inside the journal's write lock;
    // another Home's or a newer operation stays as is.
    yield* journal.updateIf(input.homeEnvironmentId, (operation) => {
      if (operation === undefined || operation.operationId !== input.operationId) return undefined;
      const { running: _running, ...rest } = operation;
      // Only the probe's own failure clears a proof; another stage's leaves it to status.
      const keepsProof = input.action !== "probe" && rest.setup?.proof !== undefined;
      return {
        ...rest,
        ...(rest.setup === undefined || keepsProof
          ? {}
          : { setup: withFailure(rest.setup, failure) }),
      };
    });
  });

  const failureOf = (
    error: ChildStepError | OrchestratorMcpFailure | Journal.ChildReadyJournalError,
    step: ChildReadyStep,
  ): ChildReadyFailure | undefined =>
    error._tag === "ChildStepError"
      ? failureFor(error.code, isStep(error.step) ? error.step : step)
      : error._tag === "ChildReadyJournalError"
        ? failureFor("storage_failed", step)
        : isFailureCode(error.reason)
          ? { ...failureFor(error.reason, step), message: error.message }
          : undefined;
  /** Every expected refusal becomes `{kind: "error"}` data at the action's step. */
  const asResult = (input: ChildReadyPrepareInput, step: ChildReadyStep, persist: boolean) =>
    Effect.catch(
      (error: ChildStepError | OrchestratorMcpFailure | Journal.ChildReadyJournalError) => {
        const failure = failureOf(error, step);
        if (failure === undefined)
          return error._tag === "OrchestratorMcpFailure" ? Effect.fail(error) : Effect.die(error);
        const answer = { kind: "error" as const, failure } satisfies ChildReadyResult;
        return persist
          ? recordFailure(input, failure).pipe(Effect.ignore, Effect.as(answer))
          : Effect.succeed(answer);
      },
    );

  const installOpenCodex = Effect.fn("OpenCodexChildReady.installOpenCodex")(function* (
    input: ChildReadyPrepareInput,
    scope: McpInvocationScope,
  ) {
    yield* authorize(input, scope);
    const previous = yield* journal
      .read(input.homeEnvironmentId)
      .pipe(storage("opencodex_running"));
    yield* journal
      .put(input.homeEnvironmentId, {
        ...(previous?.operationId === input.operationId ? previous : {}),
        operationId: input.operationId,
        homeEnvironmentId: input.homeEnvironmentId,
        destinationEnvironmentId: input.destinationEnvironmentId,
        // Ownership outlives an operation: the next one adopts, refuses or reconciles from it.
        ...(previous === undefined
          ? {}
          : {
              ...(previous.instanceId === undefined ? {} : { instanceId: previous.instanceId }),
              ...(previous.ownedFingerprint === undefined
                ? {}
                : { ownedFingerprint: previous.ownedFingerprint }),
              ...(previous.ownedInstance === undefined
                ? {}
                : { ownedInstance: previous.ownedInstance }),
              ...(previous.desiredFingerprint === undefined
                ? {}
                : { desiredFingerprint: previous.desiredFingerprint }),
              ...(previous.deleted === undefined ? {} : { deleted: previous.deleted }),
            }),
      })
      .pipe(storage("opencodex_running"));
    if (platform === "win32") yield* fullLanguagePowerShell;
    // Keeps a compatible ocx (2.66.0 or later); installs GOAT's pinned release otherwise.
    const executable = yield* installer
      .install()
      .pipe(
        Effect.mapError((error) => childError(INSTALL_FAILURE[error.reason], "opencodex_running")),
      );
    yield* authorize(input, scope);
    const device = yield* readDevice(input);
    return {
      kind: "prelink" as const,
      operationId: input.operationId,
      destinationEnvironmentId: input.destinationEnvironmentId,
      homeEnvironmentId: input.homeEnvironmentId,
      step: "opencodex_running" as const,
      version: executable.version,
      healthy: device.healthy,
    } satisfies ChildReadyResult;
  });

  const startOpenCodex = Effect.fn("OpenCodexChildReady.startOpenCodex")(function* (
    input: ChildReadyPrepareInput,
    scope: McpInvocationScope,
  ) {
    yield* authorize(input, scope);
    const before = yield* readDevice(input);
    if (before.device.ocx.path === null)
      return yield* childError("startup_failed", "opencodex_running");
    yield* startup
      .start({
        binaryPath: before.device.ocx.path,
        platform,
        opencodexHome: ABSOLUTE.test(opencodexHome) ? opencodexHome : `${cwd}/${opencodexHome}`,
        environment,
        authorize: authorize(input, scope),
      })
      .pipe(
        Effect.timeoutOrElse({
          duration: "90 seconds",
          orElse: () => Effect.fail(childError("startup_failed", "opencodex_running")),
        }),
        Effect.catchTags({
          ChildOpenCodexStartupError: () =>
            Effect.fail(childError("startup_failed", "opencodex_running")),
        }),
      );
    yield* authorize(input, scope);
    const after = yield* readDevice(input);
    if (
      !after.healthy ||
      after.device.ocx.path !== before.device.ocx.path ||
      after.device.ocx.version !== before.device.ocx.version
    )
      return yield* childError("startup_failed", "opencodex_running");
    return {
      kind: "prelink" as const,
      operationId: input.operationId,
      destinationEnvironmentId: input.destinationEnvironmentId,
      homeEnvironmentId: input.homeEnvironmentId,
      step: "opencodex_running" as const,
      version: before.device.ocx.version ?? undefined,
      healthy: true,
    } satisfies ChildReadyResult;
  });

  const opencodexHealth = Effect.fn("OpenCodexChildReady.opencodexHealth")(function* (
    input: ChildReadyPrepareInput,
    scope: McpInvocationScope,
  ) {
    yield* authorize(input, scope);
    return yield* readDevice(input);
  });

  const prepare: OpenCodexChildReady["Service"]["prepare"] = Effect.fn(
    "OpenCodexChildReady.prepare",
  )(function* (input, scope) {
    const step = STEP_OF[input.action];
    const run: Effect.Effect<
      ChildReadyResult,
      ChildStepError | OrchestratorMcpFailure | Journal.ChildReadyJournalError
    > =
      input.action === "installOpenCodex"
        ? installOpenCodex(input, scope)
        : input.action === "startOpenCodex"
          ? startOpenCodex(input, scope)
          : input.action === "opencodexHealth"
            ? opencodexHealth(input, scope)
            : linked[input.action](input, scope);
    // The address, purpose and operation are authorized before anything may write: a refused
    // request is answered and leaves every journal untouched.
    const refused = yield* authorize(input, scope).pipe(
      Effect.as(undefined),
      asResult(input, step, false),
    );
    if (refused !== undefined) return refused;
    return yield* run.pipe(asResult(input, step, true));
  });

  const status: OpenCodexChildReady["Service"]["status"] = Effect.fn("OpenCodexChildReady.status")(
    function* (input, scope) {
      if (scope.childSetupPurpose !== undefined)
        yield* authorize({ ...input, action: "status" }, scope);
      else if (
        scope.environmentId !== destinationEnvironmentId ||
        input.destinationEnvironmentId !== destinationEnvironmentId
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This status read names another destination.",
        });
      const observed = yield* observe(input);
      // Status never installs, routes or infers; a broken journal shows no setup, never Ready.
      const setup = yield* linked
        .validatedSetup(input.homeEnvironmentId, observed)
        .pipe(Effect.orElseSucceed(() => undefined));
      return {
        ...observed.device,
        ...(setup === undefined ? {} : { setup }),
      } satisfies ChildReadyResult;
    },
  );

  const connection = yield* makeChildConnection({
    destinationEnvironmentId,
    profiles,
    runner,
    host,
    inventory,
    readDevice,
    invalidateProof: (home) =>
      journal.removeProof(home).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              reason: "storage_failed",
              message: "Setup records on this Child could not be saved.",
            }),
        ),
      ),
    environment,
  });

  return OpenCodexChildReady.of({ prepare, status, connection });
});

const STEPS: ReadonlySet<string> = new Set(Object.values(STEP_OF).concat(["link_established"]));
const isStep = (value: string): value is ChildReadyStep => STEPS.has(value);

export const layer = Layer.effect(OpenCodexChildReady, make);
