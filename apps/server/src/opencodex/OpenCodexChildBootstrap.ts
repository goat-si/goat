import {
  type ChildReadyFailure,
  type ChildReadyResult,
  type ChildReadyStep,
  type ChildSetupBinding,
  CloudMachineError,
  EnvironmentId,
  hasCloudMachineAliasPrefix,
  type HubDeviceSetupInput,
  OpenCodexChildBootstrapStatus,
  type EnvironmentAuthorizationError,
  type HubDeviceMcpResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- operation ids are random identifiers.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as SessionStore from "../auth/SessionStore.ts";
import * as CloudMachines from "../cloudMachines/CloudMachineService.ts";
import * as AutomationHold from "../automationHold.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HubMembership from "../hub/HubMembership.ts";
import { HubOcx, SAFE_ALIAS } from "../hub/HubOcx.ts";
import { compareOpenCodexVersions, isStableOpenCodexVersion } from "../hub/opencodexUpdatePlan.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { SshHostCaller } from "../sshRemote/SshHostAuthorization.ts";
import * as SshHostSetup from "../sshRemote/SshHostSetup.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ReadyDispatch from "./ChildReadyDispatch.ts";
import {
  decodeStoredRecords,
  presentSetupAction,
  setupResult,
  withCurrentProof,
  withSetupFailure,
} from "./childBootstrapStatus.ts";
import * as Inventory from "./OpenCodexInventory.ts";
import { CHILD_MINIMUM_VERSION } from "./childPrepare.ts";
import { makeSshChildConsent } from "./sshChildConsent.ts";

const STATE_FILE = "opencodex-child-bootstrap.json";
const CONSENT_FILE = "opencodex-child-ssh-consent.json";
/** A blocked machine is tried again on a later readying, but not on every one. */
const RETRY_AFTER_MS = 10 * 60_000;

type Status = OpenCodexChildBootstrapStatus;
type Reason = NonNullable<Status["reason"]>;
const Records = Schema.Record(Schema.String, OpenCodexChildBootstrapStatus);
const encodeRecords = Schema.encodeEffect(Schema.fromJsonString(Records));

const RUNTIME_MISSING = "GOAT's runtime is not available there. Finish SSH setup and retry.";
/** Whether a join may still happen: the hub's cloud switch, or an SSH host's standing consent. */
type Admission =
  | { readonly state: "allowed" }
  | { readonly state: "withdrawn" }
  | { readonly state: "revoked"; readonly dropped: boolean; readonly message: string };
interface Gate {
  /** Read before a job starts and again once the machine is prepared. */
  readonly admission: Effect.Effect<Admission>;
  /** HubMembership reads the same permission again under its permit and before linking. */
  readonly join: (
    scope: McpInvocationScope,
  ) => Effect.Effect<HubDeviceMcpResult, OrchestratorMcpFailure>;
  /** The consent's identity now, read fresh: a setup purpose is issued only while it holds. */
  readonly grant: Effect.Effect<{
    readonly enabled: boolean;
    readonly grantId: string;
    readonly grantRevision: number;
  }>;
}

export class OpenCodexChildBootstrap extends Context.Service<
  OpenCodexChildBootstrap,
  {
    /**
     * Installs OpenCodex on a cloud machine this Home created, or an SSH host a person opted in,
     * starts it and links it as a Remote Link Child; joins the setup already running for it. Every
     * step is skipped when it is already done, so running it again is safe. Undefined when nothing
     * permits it: not a hub, the cloud switch off, or no consent for the SSH host.
     */
    readonly ensure: (alias: string) => Effect.Effect<Status | undefined>;
    /** The last outcome for a machine, or undefined when this Home never tried it. */
    readonly status: (alias: string) => Effect.Effect<Status | undefined>;
    /**
     * A person turns an SSH host's Child setup on or off. On starts a setup now; after that each
     * successful SSH setup of the host runs it. Off stops any join still to come and never unlinks.
     */
    readonly setSshOptIn: (
      alias: string,
      enabled: boolean,
      caller: SshHostCaller,
    ) => Effect.Effect<void, OrchestratorMcpFailure | EnvironmentAuthorizationError>;
    /** Whether an SSH host is opted in; undefined while not a hub and for hosts that cannot be. */
    readonly sshOptIn: (alias: string) => Effect.Effect<boolean | undefined>;
    /**
     * Retries or finishes one machine's setup under its standing consent; a Child linked before
     * setup existed finishes without linking again. Never gives consent.
     */
    readonly setupDevice: (input: HubDeviceSetupInput) => Effect.Effect<ChildReadyResult>;
  }
>()("goat/opencodex/OpenCodexChildBootstrap") {}

const make = Effect.gen(function* () {
  const cloud = yield* CloudMachines.CloudMachineService;
  const hold = yield* AutomationHold.AutomationHold;
  const ssh = yield* SshHostSetup.SshHostSetup;
  const ocx = yield* HubOcx;
  const membership = yield* HubMembership.HubMembership;
  const inventory = yield* Inventory.OpenCodexInventory;
  const childReady = yield* ReadyDispatch.ChildReadyDispatch;
  const sshDispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serviceScope = yield* Scope.Scope;
  const stateFile = path.join(config.stateDir, STATE_FILE);
  const consents = yield* makeSshChildConsent({
    directory: config.stateDir,
    file: path.join(config.stateDir, CONSENT_FILE),
    sessions: yield* SessionStore.SessionStore,
    revision: ssh.aliasRevision,
  });
  const writing = yield* Semaphore.make(1);
  const jobs = new Map<string, Fiber.Fiber<Status | undefined>>();
  const releases = new Map<string, Fiber.Fiber<void>>();

  const bootedAt = yield* Clock.currentTimeMillis;
  const stored = yield* fs.readFileString(stateFile).pipe(
    Effect.map((text) => decodeStoredRecords(text, bootedAt)),
    Effect.catch((error) =>
      (error.reason._tag === "NotFound"
        ? Effect.void
        : Effect.logWarning("Child setup records could not be read.")
      ).pipe(Effect.as<Readonly<Record<string, Status>>>({})),
    ),
  );
  // A job does not outlive the server, so a "running" record from before a restart is stale.
  const initial = Object.fromEntries(
    Object.entries(stored).map(([alias, status]): [string, Status] => [
      alias,
      status.state === "running"
        ? {
            ...status,
            state: "blocked",
            reason: "unreachable",
            message: "GOAT restarted during setup.",
          }
        : status,
    ]),
  );
  const records = yield* Ref.make<Readonly<Record<string, Status>>>(initial);
  /**
   * One atomic write per change, published only after the rename, so a restart sees each outcome
   * whole or not at all and a failed write never reads as done.
   */
  const save = (change: (current: Readonly<Record<string, Status>>) => Record<string, Status>) =>
    writing.withPermits(1)(
      Effect.gen(function* () {
        const next = change(yield* Ref.get(records));
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(`${stateFile}.tmp`, yield* encodeRecords(next));
        yield* fs.rename(`${stateFile}.tmp`, stateFile);
        yield* Ref.set(records, next);
      }),
    );
  /** A record that could not be saved is answered as a storage failure, never as Ready. */
  const record = Effect.fn("OpenCodexChildBootstrap.record")(function* (
    alias: string,
    status: Omit<Status, "checkedAt">,
  ) {
    const next: Status = { ...status, checkedAt: yield* Clock.currentTimeMillis };
    const saved = yield* save((current) => ({ ...current, [alias]: next })).pipe(Effect.result);
    if (saved._tag === "Success") return next;
    yield* Effect.logWarning("Child setup record could not be saved.");
    return {
      ...withSetupFailure(next, {
        code: "storage_failed",
        step: next.step ?? "goat_available",
        message: "This Home could not save the setup record. Retry setup.",
        retryable: true,
      }),
      checkedAt: next.checkedAt,
    } satisfies Status;
  });
  const discard = (alias: string) =>
    save((current) => {
      const { [alias]: _gone, ...rest } = current;
      return rest;
    }).pipe(Effect.ignore({ log: true }));

  // As last committed: a full read can wait on secrets and answer from before a change.
  const hubSettings = (
    settings.committedHub ?? settings.getSettings.pipe(Effect.map((configured) => configured.hub))
  ).pipe(Effect.option);
  const hubEnabled = hubSettings.pipe(Effect.map((hub) => Option.isSome(hub) && hub.value.enabled));
  const cloudAllowed = hubSettings.pipe(
    Effect.map((hub) => Option.isSome(hub) && hub.value.enabled && hub.value.autoJoinCloudMachines),
  );

  const joined = (alias: string, version: string | undefined, outcome: HubDeviceMcpResult) =>
    record(alias, {
      state:
        outcome.state === "child" ? "child" : outcome.state === "degraded" ? "degraded" : "blocked",
      ...(outcome.state === "child" || outcome.state === "degraded"
        ? {}
        : { reason: "link_failed" as const }),
      message: outcome.message,
      ...(version === undefined ? {} : { version }),
    });
  /** A join that may no longer happen: withdrawn leaves no trace, revoked says why. */
  const stopped = (alias: string, admission: Exclude<Admission, { state: "allowed" }>) =>
    admission.state === "withdrawn"
      ? discard(alias).pipe(Effect.as(undefined))
      : record(alias, {
          state: "blocked",
          reason: admission.dropped ? "consent_revoked" : "link_failed",
          message: admission.message,
        });

  // Each active setup operation's binding, so a consent change can revoke its Child sessions.
  const setupBindings = new Map<
    string,
    { readonly alias: string; readonly binding: ChildSetupBinding; activeStep: ChildReadyStep }
  >();
  const recordSetupFailure = Effect.fn("OpenCodexChildBootstrap.recordSetupFailure")(function* (
    alias: string,
    failure: ChildReadyFailure,
  ) {
    return yield* record(alias, withSetupFailure((yield* Ref.get(records))[alias], failure));
  });
  /** Revokes every Child setup session still out for this machine; consent is already off. */
  const revokeSetupForAlias = Effect.fn("OpenCodexChildBootstrap.revokeSetupForAlias")(function* (
    alias: string,
  ) {
    for (const [operationId, held] of setupBindings) {
      if (held.alias !== alias) continue;
      const result = yield* sshDispatch.revokeChildSetupSessions(held.binding).pipe(Effect.result);
      yield* recordSetupFailure(alias, {
        code: "setup_approval_revoked",
        step: held.activeStep,
        retryable: false,
        message: "Child setup approval was revoked.",
      });
      if (result._tag === "Success") setupBindings.delete(operationId);
      else
        yield* Effect.logWarning(
          "Child setup session cleanup failed; its Home admission remains revoked.",
        );
    }
  });
  /** The Home's consent bound into a fresh purpose per phase, re-read around every call. */
  const dispatchAdmission = Effect.fn("OpenCodexChildBootstrap.dispatchAdmission")(function* (
    alias: string,
    gate: Gate,
    destinationEnvironmentId: EnvironmentId,
  ) {
    const grant = yield* gate.grant;
    const binding: ChildSetupBinding = {
      purpose: "opencodex-child-setup",
      homeEnvironmentId: yield* environment.getEnvironmentId,
      destinationEnvironmentId,
      operationId: NodeCrypto.randomUUID(),
      grantId: grant.grantId,
      grantRevision: grant.grantRevision,
    };
    const held = { alias, binding, activeStep: "goat_available" as ChildReadyStep };
    setupBindings.set(binding.operationId, held);
    const cleanup = sshDispatch.revokeChildSetupSessions(binding).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            reason: "unreachable",
            message: "The Child could not acknowledge setup session cleanup.",
          }),
      ),
    );
    return ReadyDispatch.makeAdmission(
      binding,
      "approval-required",
      gate.grant,
      cleanup,
      (step) => {
        held.activeStep = step;
      },
    );
  });
  /** Ends an operation's leftover phase sessions once it finished; failures keep it tracked. */
  const releaseAdmission = (admission: ReadyDispatch.ChildSetupAdmission) =>
    sshDispatch.revokeChildSetupSessions(admission.binding).pipe(
      Effect.tap(() => Effect.sync(() => setupBindings.delete(admission.binding.operationId))),
      Effect.ignore({ log: true }),
    );
  /**
   * The destination's own environment id, read over the pinned SSH channel like revocation:
   * no MCP session is minted for it, so setup never holds an ordinary operate credential.
   */
  const identify = Effect.fn("OpenCodexChildBootstrap.identify")(function* (
    alias: string,
    gate: Gate,
  ) {
    if ((yield* gate.admission).state !== "allowed")
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        reason: "setup_approval_revoked",
        message: "Child setup approval was revoked.",
      });
    const identity = yield* sshDispatch.identifyTarget({
      alias,
      hostname: alias,
      username: null,
      port: null,
    });
    if (identity === null)
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        reason: "unreachable",
        message: "GOAT there did not identify its environment.",
      });
    return identity;
  });
  /** Finishes the Child's own setup over the Home link it was joined with. */
  const complete = Effect.fn("OpenCodexChildBootstrap.complete")(function* (
    alias: string,
    admission: ReadyDispatch.ChildSetupAdmission,
    expectedLinkId: string,
  ) {
    const completed = yield* childReady
      .complete(alias, admission.binding.homeEnvironmentId, admission, expectedLinkId)
      .pipe(Effect.result);
    yield* releaseAdmission(admission);
    if (completed._tag === "Failure")
      return yield* recordSetupFailure(
        alias,
        ReadyDispatch.toChildReadyFailure(completed.failure, "link_established"),
      );
    const {
      failure: _failure,
      nextAction: _nextAction,
      actionable: _actionable,
      reason: _reason,
      ...membership
    } = (yield* Ref.get(records))[alias] ?? { state: "child" as const, checkedAt: 0 };
    return yield* record(
      alias,
      presentSetupAction({
        ...membership,
        state: membership.state === "degraded" ? "degraded" : "child",
        step: "inference_verified",
        setup: completed.success,
        checkedAt: 0,
      }),
    );
  });

  const run = Effect.fn("OpenCodexChildBootstrap.run")(function* (alias: string, gate: Gate) {
    const blocked = (reason: Reason, message: string, version?: string) =>
      record(alias, { state: "blocked", reason, message, ...(version ? { version } : {}) });
    yield* record(alias, { state: "running", step: "goat_available" });
    const home = (yield* inventory.read).binaries[0]?.version;
    if (
      !isStableOpenCodexVersion(home) ||
      compareOpenCodexVersions(home, CHILD_MINIMUM_VERSION) < 0
    )
      return yield* blocked(
        "home_unavailable",
        `This Home needs OpenCodex ${CHILD_MINIMUM_VERSION} or later to prepare a Child.`,
      );
    if ((yield* ocx.devicePlatform(alias)) === "windows")
      return yield* blocked("platform_unsupported", "Remote Link refuses Windows Children.");
    // GOAT's own runtime installs OpenCodex there, so it is ensured first; that can wait on
    // provisioning, and the switch or the consent may change meanwhile.
    const admitted = yield* gate.admission;
    if (admitted.state !== "allowed") return yield* stopped(alias, admitted);
    const runtime = yield* ocx.ensureDeviceRuntime(alias).pipe(
      Effect.map((ready) => ({ ok: true as const, ready })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    );
    if (!runtime.ok) return yield* blocked("unreachable", runtime.error.message);
    if (!runtime.ready) return yield* blocked("goat_runtime_missing", RUNTIME_MISSING);
    const provisioned = yield* gate.admission;
    if (provisioned.state !== "allowed") return yield* stopped(alias, provisioned);
    const destination = yield* identify(alias, gate).pipe(Effect.result);
    if (destination._tag === "Failure")
      return yield* blocked("unreachable", "GOAT there did not identify its environment.");
    const setupAdmission = yield* dispatchAdmission(alias, gate, destination.success);
    yield* record(alias, { state: "running", step: "opencodex_running" });
    const prepared = yield* childReady
      .prepare(alias, setupAdmission.binding.homeEnvironmentId, setupAdmission)
      .pipe(Effect.result);
    if (prepared._tag === "Failure") {
      yield* releaseAdmission(setupAdmission);
      const failure = ReadyDispatch.toChildReadyFailure(prepared.failure, "opencodex_running");
      const timedOut = failure.code === "purpose_expired" || failure.code === "phase_timeout";
      return yield* record(
        alias,
        presentSetupAction({
          ...withSetupFailure(undefined, failure),
          reason:
            failure.code === "remote_outdated" || failure.code === "ocx_unusable"
              ? "ocx_unusable"
              : timedOut
                ? "setup_step_timeout"
                : failure.code === "installation_failed"
                  ? "install_failed"
                  : failure.code === "platform_unsupported"
                    ? "platform_unsupported"
                    : failure.code === "setup_approval_revoked"
                      ? "consent_revoked"
                      : "runtime_unhealthy",
          message: failure.message,
          checkedAt: 0,
        }),
      );
    }
    const version = prepared.success.device.ocx.version ?? undefined;
    // Preparing takes minutes; the switch or the consent may have changed meanwhile.
    const ready = yield* gate.admission;
    if (ready.state !== "allowed") {
      yield* releaseAdmission(setupAdmission);
      return yield* stopped(alias, ready);
    }
    yield* record(alias, {
      state: "running",
      step: "link_established",
      ...(version ? { version } : {}),
    });
    const scope: McpInvocationScope = {
      environmentId: yield* environment.getEnvironmentId.pipe(
        Effect.orElseSucceed(() => EnvironmentId.make("local")),
      ),
      capabilities: new Set(["orchestration"]),
      issuedAt: yield* Clock.currentTimeMillis,
      requestNamespace: "opencodex-child-bootstrap",
      thread: undefined,
      client: {
        sessionId: "opencodex-child-bootstrap",
        label: "GOAT Child setup",
        access: "read-only",
      },
    };
    return yield* gate.join(scope).pipe(
      Effect.flatMap((result) =>
        Effect.gen(function* () {
          if (result.state !== "child" && result.state !== "degraded") {
            yield* releaseAdmission(setupAdmission);
            const after = yield* gate.admission;
            // A join the hub called off reads as withdrawn here too.
            return yield* after.state === "allowed"
              ? joined(alias, version, result)
              : stopped(alias, after);
          }
          yield* joined(alias, version, result);
          const after = yield* gate.admission;
          if (after.state !== "allowed") {
            yield* releaseAdmission(setupAdmission);
            return yield* stopped(alias, after);
          }
          const expectedLinkId = result.steps.find(
            (step) => step.step === "link_add" && step.outcome === "ok",
          )?.detail;
          if (expectedLinkId === undefined || expectedLinkId.length === 0) {
            yield* releaseAdmission(setupAdmission);
            return yield* recordSetupFailure(alias, {
              code: "link_changed",
              step: "link_established",
              message: "The Home did not return its added link ID.",
              retryable: false,
            });
          }
          return yield* complete(alias, setupAdmission, expectedLinkId);
        }),
      ),
      Effect.catch((error) =>
        releaseAdmission(setupAdmission).pipe(
          Effect.andThen(blocked("link_failed", error.message, version)),
        ),
      ),
    );
  });

  /**
   * A Child linked before setup existed, or one whose setup stopped after linking: its Home
   * link record names the link, and only the Child's own steps run. No relink.
   */
  const finish = Effect.fn("OpenCodexChildBootstrap.finish")(function* (alias: string, gate: Gate) {
    const admitted = yield* gate.admission;
    if (admitted.state !== "allowed") return yield* stopped(alias, admitted);
    const linkId = (yield* inventory.read).link.links.find((link) => link.alias === alias)?.id;
    if (linkId === undefined)
      return yield* recordSetupFailure(alias, {
        code: "link_changed",
        step: "link_established",
        message: "This Home has no link for the machine. Reconnect it, then retry.",
        retryable: false,
      });
    const destination = yield* identify(alias, gate).pipe(Effect.result);
    if (destination._tag === "Failure")
      return yield* recordSetupFailure(alias, {
        code: "unreachable",
        step: "link_established",
        message: "GOAT there did not identify its environment.",
        retryable: true,
      });
    const admission = yield* dispatchAdmission(alias, gate, destination.success);
    return yield* complete(alias, admission, linkId);
  });

  /** One job per machine: a second caller joins the job already running for it. */
  const start = Effect.fn("OpenCodexChildBootstrap.start")(function* (
    alias: string,
    gate: Gate,
    work: typeof run = run,
  ) {
    const existing = jobs.get(alias);
    if (existing !== undefined) return existing;
    const fiber = yield* hold.awaitRelease.pipe(
      Effect.andThen(work(alias, gate)),
      Effect.catchCause(() =>
        record(alias, { state: "blocked", reason: "link_failed", message: "Setup stopped." }),
      ),
      Effect.ensuring(Effect.sync(() => jobs.delete(alias))),
      Effect.forkIn(serviceScope, { startImmediately: false }),
    );
    jobs.set(alias, fiber);
    // Visible before the job runs, so a reader never sees a stale outcome for a started job.
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(records, (current) => ({
      ...current,
      [alias]:
        work === run
          ? { state: "running" as const, step: "goat_available" as const, checkedAt: now }
          : { ...current[alias], state: current[alias]?.state ?? "child", checkedAt: now },
    }));
    return fiber;
  });

  /** A joined Child is left to goat_hub_device_repair; a blocked one waits before retrying. */
  const due = Effect.fn("OpenCodexChildBootstrap.due")(function* (alias: string) {
    const previous = (yield* Ref.get(records))[alias];
    const now = yield* Clock.currentTimeMillis;
    if (previous?.state === "child" || previous?.state === "degraded") return false;
    return !(previous?.state === "blocked" && now - previous.checkedAt < RETRY_AFTER_MS);
  });

  // Every cloud setup binds this generation. Each committed change of the cloud switch bumps it,
  // so an off-then-on during a request still fails that request's post-reply check, and turning
  // it off revokes the sessions already delegated. The epoch keeps ids unique per process.
  const cloudEpoch = NodeCrypto.randomUUID();
  let cloudGeneration = 0;
  const changes = yield* settings.subscribeChanges.pipe(Scope.provide(serviceScope));
  let cloudOn = yield* cloudAllowed;
  let hubOn = yield* hubEnabled;
  yield* changes.pipe(
    Stream.runForEach((next) =>
      Effect.gen(function* () {
        const hub = next.hub.enabled;
        const cloudNow = hub && next.hub.autoJoinCloudMachines;
        const withdrawnHub = hubOn && !hub;
        const withdrawnCloud = cloudOn && !cloudNow;
        if (cloudNow !== cloudOn) cloudGeneration++;
        hubOn = hub;
        cloudOn = cloudNow;
        if (!withdrawnHub && !withdrawnCloud) return;
        const aliases = new Set(
          [...setupBindings.values()]
            .filter((held) => withdrawnHub || hasCloudMachineAliasPrefix(held.alias))
            .map((held) => held.alias),
        );
        for (const alias of aliases) yield* revokeSetupForAlias(alias);
      }),
    ),
    Effect.ignore({ log: true }),
    Effect.forkIn(serviceScope),
  );
  const cloudGate = (alias: string): Gate => ({
    admission: cloudAllowed.pipe(
      Effect.map((allowed): Admission => ({ state: allowed ? "allowed" : "withdrawn" })),
    ),
    join: (scope) => membership.joinProvisioned(scope, alias, cloudAllowed),
    // Cloud setup needs the switch on and this Home still owning the machine, read each time.
    grant: Effect.all([cloudAllowed, cloud.owns(alias)]).pipe(
      Effect.map(([allowed, owned]) => ({
        enabled: allowed && owned,
        grantId: `cloud:${alias}:${cloudEpoch}`,
        grantRevision: cloudGeneration,
      })),
    ),
  });

  /** `retry`: a readying respects the retry wait; a direct request does not. */
  const startCloud = Effect.fn("OpenCodexChildBootstrap.startCloud")(function* (
    alias: string,
    retry: boolean,
  ) {
    if (jobs.has(alias) || !(yield* cloudAllowed) || !(yield* cloud.owns(alias))) return undefined;
    if (retry && !(yield* due(alias))) return undefined;
    return { job: yield* start(alias, cloudGate(alias)) };
  });
  yield* cloud.onReady((alias) => startCloud(alias, true).pipe(Effect.asVoid));

  /**
   * An SSH job keeps the alias generation and grant it started with: a Forget, or consent given
   * again, ends its permission even before the files or the session change.
   */
  const sshAdmission = Effect.fn("OpenCodexChildBootstrap.sshAdmission")(function* (
    alias: string,
    generation: number,
    grantId: string,
  ) {
    // Reads that can wait come first: the alias's files, then the committed hub settings.
    const checked = yield* consents.check(alias);
    if (checked.state === "revoked") return checked;
    if (!(yield* hubEnabled)) return { state: "withdrawn" } as const;
    // Then memory only, so a Forget, withdrawal or sign-out during those reads still counts.
    if ((yield* ssh.aliasGeneration(alias)) !== generation) return { state: "withdrawn" } as const;
    const consent = yield* consents.confirm(alias, grantId);
    if (consent.state === "revoked") return consent;
    if (consent.state === "none") return { state: "withdrawn" } as const;
    return { state: "allowed", person: consent.person } as const;
  });
  const sshGate = (alias: string, generation: number, grantId: string): Gate => {
    // The read that finds a revoked grant drops it, so a later read only sees it gone; the job
    // keeps the reason to show.
    let revoked: Extract<Admission, { state: "revoked" }> | undefined;
    const admission = sshAdmission(alias, generation, grantId).pipe(
      Effect.map((read) => {
        if (read.state === "revoked") revoked = read;
        return read.state === "withdrawn" && revoked !== undefined ? revoked : read;
      }),
    );
    return {
      admission,
      join: (scope) =>
        membership.joinWithConsent(
          scope,
          alias,
          admission.pipe(
            Effect.map((read) => (read.state === "allowed" ? read.person : undefined)),
          ),
        ),
      // The purpose binds this grant and alias generation; a new grant or a Forget ends it.
      grant: admission.pipe(
        Effect.map((read) => ({
          enabled: read.state === "allowed",
          grantId,
          grantRevision: generation,
        })),
      ),
    };
  };
  const startSsh = Effect.fn("OpenCodexChildBootstrap.startSsh")(function* (
    alias: string,
    retry: boolean,
  ) {
    if (jobs.has(alias) || hasCloudMachineAliasPrefix(alias) || !(yield* hubEnabled))
      return undefined;
    const generation = yield* ssh.aliasGeneration(alias);
    const consent = yield* consents.check(alias);
    if (consent.state === "none") return undefined;
    if (consent.state === "revoked") return { status: yield* stopped(alias, consent) };
    if (retry && !(yield* due(alias))) return undefined;
    return { job: yield* start(alias, sshGate(alias, generation, consent.grant.grantId)) };
  });
  yield* ssh.onAlias((alias, event) =>
    event === "ready"
      ? startSsh(alias, true).pipe(Effect.asVoid)
      : // Durable before Forget goes on, so a restart never brings the consent back.
        consents
          .forget(alias)
          .pipe(Effect.andThen(revokeSetupForAlias(alias)), Effect.andThen(discard(alias))),
  );

  const ensure: OpenCodexChildBootstrap["Service"]["ensure"] = Effect.fn(
    "OpenCodexChildBootstrap.ensure",
  )(function* (alias) {
    const running = jobs.get(alias);
    if (running !== undefined) return yield* Fiber.join(running);
    const started = hasCloudMachineAliasPrefix(alias)
      ? yield* startCloud(alias, false)
      : yield* startSsh(alias, false);
    return started === undefined
      ? undefined
      : "job" in started
        ? yield* Fiber.join(started.job)
        : started.status;
  });

  const setSshOptIn: OpenCodexChildBootstrap["Service"]["setSshOptIn"] = Effect.fn(
    "OpenCodexChildBootstrap.setSshOptIn",
  )(function* (alias, enabled, caller) {
    yield* consents.set(alias, enabled, caller);
    if (enabled) {
      const running = jobs.get(alias);
      // A setup under the earlier grant stops at its next check; one under this grant follows it.
      if (running === undefined) yield* startSsh(alias, false);
      else
        yield* Fiber.await(running).pipe(
          Effect.andThen(startSsh(alias, false)),
          Effect.forkIn(serviceScope),
        );
      return;
    }
    // Sessions already delegated to the Child end now; a running job sees the withdrawal itself.
    yield* revokeSetupForAlias(alias);
    if (!jobs.has(alias) && (yield* Ref.get(records))[alias]?.state === "blocked")
      yield* discard(alias);
  });

  const sshOptIn: OpenCodexChildBootstrap["Service"]["sshOptIn"] = Effect.fn(
    "OpenCodexChildBootstrap.sshOptIn",
  )(function* (alias) {
    if (!SAFE_ALIAS.test(alias) || hasCloudMachineAliasPrefix(alias) || !(yield* hubEnabled))
      return undefined;
    const revision = yield* ssh.aliasRevision(alias).pipe(Effect.orElseSucceed(() => undefined));
    if (revision === undefined) return undefined;
    if ((yield* consents.held(alias)) === undefined) return false;
    // Reconciled on every read, so a signed-out or expired session turns the switch off and the
    // host says why, without waiting for its next setup. A Child stays one.
    const consent = yield* consents.check(alias);
    if (consent.state === "revoked" && consent.dropped) yield* revokeSetupForAlias(alias);
    if (consent.state === "revoked" && consent.dropped && !jobs.has(alias)) {
      const previous = (yield* Ref.get(records))[alias]?.state;
      if (previous !== "child" && previous !== "degraded") yield* stopped(alias, consent);
    }
    return consent.state === "granted" || (consent.state === "revoked" && !consent.dropped);
  });

  /**
   * Revokes the link this Home added for a deleted or forgotten machine. Only a catalog that says
   * so releases it; until then, or when the revoke fails, the hub keeps the release pending.
   */
  const release = Effect.fn("OpenCodexChildBootstrap.release")(function* (alias: string) {
    if (!(yield* cloud.isRemoved(alias))) return;
    yield* membership.releaseProvisioned(alias);
  });
  const startRelease = Effect.fn("OpenCodexChildBootstrap.startRelease")(function* (alias: string) {
    if (releases.has(alias)) return;
    const fiber = yield* hold.awaitRelease.pipe(
      Effect.andThen(release(alias)),
      Effect.ignore({ log: true }),
      Effect.ensuring(Effect.sync(() => releases.delete(alias))),
      Effect.forkIn(serviceScope, { startImmediately: false }),
    );
    releases.set(alias, fiber);
  });
  // Recorded before the catalog lets go of the machine, so the release survives a restart.
  yield* cloud.onRemoving((alias) =>
    membership
      .requestRelease(alias)
      .pipe(Effect.mapError(() => new CloudMachineError({ reason: "storage_failed" }))),
  );
  // A removed machine is gone for good; a stopped one keeps its record and link for its next start.
  yield* cloud.onAliasInvalidated((alias, cause) =>
    revokeSetupForAlias(alias).pipe(
      Effect.andThen(
        cause !== "removed"
          ? Effect.void
          : discard(alias).pipe(Effect.andThen(startRelease(alias))),
      ),
    ),
  );
  // Releases that failed, or never ran, before this start.
  yield* membership.pendingReleases.pipe(
    Effect.flatMap((aliases) => Effect.forEach(aliases, startRelease, { discard: true })),
    Effect.ignore({ log: true }),
  );

  /** The last outcome, with its next action; an expired proof reads invalid. No request. */
  const status: OpenCodexChildBootstrap["Service"]["status"] = Effect.fn(
    "OpenCodexChildBootstrap.status",
  )(function* (alias) {
    const current = (yield* Ref.get(records))[alias];
    if (current === undefined) return undefined;
    return presentSetupAction(withCurrentProof(current, yield* Clock.currentTimeMillis));
  });

  const setupDevice: OpenCodexChildBootstrap["Service"]["setupDevice"] = Effect.fn(
    "OpenCodexChildBootstrap.setupDevice",
  )(function* (input) {
    const alias = input.deviceAlias;
    if (!SAFE_ALIAS.test(alias)) return setupResult(undefined);
    const running = jobs.get(alias);
    if (running !== undefined) return setupResult(yield* Fiber.join(running));
    const cloudAlias = hasCloudMachineAliasPrefix(alias);
    let gate: Gate | undefined;
    if (cloudAlias) {
      if ((yield* cloudAllowed) && (yield* cloud.owns(alias))) gate = cloudGate(alias);
    } else if (yield* hubEnabled) {
      const generation = yield* ssh.aliasGeneration(alias);
      const consent = yield* consents.check(alias);
      if (consent.state === "revoked") return setupResult(yield* stopped(alias, consent));
      if (consent.state === "granted") gate = sshGate(alias, generation, consent.grant.grantId);
    }
    // Retry never gives consent: without it nothing runs.
    if (gate === undefined) return setupResult(undefined);
    const previous = (yield* Ref.get(records))[alias];
    const linked = previous?.state === "child" || previous?.state === "degraded";
    return setupResult(yield* Fiber.join(yield* start(alias, gate, linked ? finish : run)));
  });

  return OpenCodexChildBootstrap.of({
    ensure,
    status,
    setSshOptIn,
    sshOptIn,
    setupDevice,
  });
});

export const layer = Layer.effect(OpenCodexChildBootstrap, make);
