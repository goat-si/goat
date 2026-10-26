import {
  CloudMachineError,
  EnvironmentId,
  hasCloudMachineAliasPrefix,
  OpenCodexChildBootstrapStatus,
  type EnvironmentAuthorizationError,
  type HubDeviceMcpResult,
  type OrchestratorMcpFailure,
} from "@goat/contracts";
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

import * as SessionStore from "../auth/SessionStore.ts";
import * as CloudMachines from "../cloudMachines/CloudMachineService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HubMembership from "../hub/HubMembership.ts";
import { HubOcx, SAFE_ALIAS } from "../hub/HubOcx.ts";
import { compareOpenCodexVersions, isStableOpenCodexVersion } from "../hub/opencodexUpdatePlan.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { SshHostCaller } from "../sshRemote/SshHostAuthorization.ts";
import * as SshHostSetup from "../sshRemote/SshHostSetup.ts";
import * as Inventory from "./OpenCodexInventory.ts";
import { CHILD_MINIMUM_VERSION, PREPARE_EXIT } from "./childPrepare.ts";
import { makeSshChildConsent } from "./sshChildConsent.ts";

const STATE_FILE = "opencodex-child-bootstrap.json";
const CONSENT_FILE = "opencodex-child-ssh-consent.json";
// npm downloads OpenCodex and its bundled Bun runtime, then the service gets 40 seconds to answer.
const PREPARE_TIMEOUT_MS = 15 * 60_000;
/** A blocked machine is tried again on a later readying, but not on every one. */
const RETRY_AFTER_MS = 10 * 60_000;

type Status = OpenCodexChildBootstrapStatus;
type Reason = NonNullable<Status["reason"]>;
const Records = Schema.Record(Schema.String, OpenCodexChildBootstrapStatus);
const decodeRecords = Schema.decodeUnknownOption(Schema.fromJsonString(Records));
const encodeRecords = Schema.encodeSync(Schema.fromJsonString(Records));

const PREPARE_REASONS: Readonly<Record<number, readonly [Reason, string]>> = {
  [PREPARE_EXIT.npmMissing]: [
    "npm_missing",
    "npm is not installed there. OpenCodex installs with npm (Node 18 or later).",
  ],
  [PREPARE_EXIT.installFailed]: ["install_failed", "npm could not install OpenCodex there."],
  [PREPARE_EXIT.ocxUnusable]: [
    "ocx_unusable",
    `After installing, the first ocx there still is not OpenCodex ${CHILD_MINIMUM_VERSION} or later.`,
  ],
  [PREPARE_EXIT.runtimeUnhealthy]: [
    "runtime_unhealthy",
    "OpenCodex is installed there but did not start; see ~/.opencodex/goat-start.log on it.",
  ],
};

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
  }
>()("goat/opencodex/OpenCodexChildBootstrap") {}

const make = Effect.gen(function* () {
  const cloud = yield* CloudMachines.CloudMachineService;
  const ssh = yield* SshHostSetup.SshHostSetup;
  const ocx = yield* HubOcx;
  const membership = yield* HubMembership.HubMembership;
  const inventory = yield* Inventory.OpenCodexInventory;
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

  const stored = yield* fs.readFileString(stateFile).pipe(
    Effect.map((text) => Option.getOrElse(decodeRecords(text), () => ({}))),
    Effect.orElseSucceed((): Readonly<Record<string, Status>> => ({})),
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
  /** One atomic write per change, so a restart sees each outcome whole or not at all. */
  const save = (change: (current: Readonly<Record<string, Status>>) => Record<string, Status>) =>
    writing.withPermits(1)(
      Effect.gen(function* () {
        const next = change(yield* Ref.get(records));
        yield* Ref.set(records, next);
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(`${stateFile}.tmp`, encodeRecords(next));
        yield* fs.rename(`${stateFile}.tmp`, stateFile);
      }).pipe(Effect.ignore({ log: true })),
    );
  const record = Effect.fn("OpenCodexChildBootstrap.record")(function* (
    alias: string,
    status: Omit<Status, "checkedAt">,
  ) {
    const next: Status = { ...status, checkedAt: yield* Clock.currentTimeMillis };
    yield* save((current) => ({ ...current, [alias]: next }));
    return next;
  });
  const discard = (alias: string) =>
    save((current) => {
      const { [alias]: _gone, ...rest } = current;
      return rest;
    });

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

  const run = Effect.fn("OpenCodexChildBootstrap.run")(function* (alias: string, gate: Gate) {
    const blocked = (reason: Reason, message: string, version?: string) =>
      record(alias, { state: "blocked", reason, message, ...(version ? { version } : {}) });
    yield* record(alias, { state: "running" });
    const home = (yield* inventory.read).binaries[0]?.version;
    if (
      !isStableOpenCodexVersion(home) ||
      compareOpenCodexVersions(home, CHILD_MINIMUM_VERSION) < 0
    )
      return yield* blocked(
        "home_unavailable",
        `This Home needs OpenCodex ${CHILD_MINIMUM_VERSION} or later to install the same release there.`,
      );
    if ((yield* ocx.devicePlatform(alias)) === "windows")
      return yield* blocked("platform_unsupported", "Remote Link refuses Windows Children.");
    const prepared = yield* ocx.prepareDevice(alias, home, PREPARE_TIMEOUT_MS).pipe(
      Effect.map((output) => ({ ok: true as const, output })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    );
    if (!prepared.ok) return yield* blocked("unreachable", prepared.error.message);
    const known = PREPARE_REASONS[prepared.output.code];
    if (prepared.output.code !== 0)
      return yield* blocked(
        known?.[0] ?? "install_failed",
        known?.[1] ?? `Preparing OpenCodex there exited ${prepared.output.code}.`,
      );
    const version = prepared.output.stdout.trim() || undefined;
    // Preparing takes minutes; the switch or the consent may have changed meanwhile.
    const ready = yield* gate.admission;
    if (ready.state !== "allowed") return yield* stopped(alias, ready);
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
        result.state === "child" || result.state === "degraded"
          ? joined(alias, version, result)
          : // A join the hub called off reads as withdrawn here too.
            Effect.flatMap(gate.admission, (after) =>
              after.state === "allowed" ? joined(alias, version, result) : stopped(alias, after),
            ),
      ),
      Effect.catch((error) => blocked("link_failed", error.message, version)),
    );
  });

  /** One job per machine: a second caller joins the job already running for it. */
  const start = Effect.fn("OpenCodexChildBootstrap.start")(function* (alias: string, gate: Gate) {
    const existing = jobs.get(alias);
    if (existing !== undefined) return existing;
    const fiber = yield* run(alias, gate).pipe(
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
      [alias]: { state: "running" as const, checkedAt: now },
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

  const cloudGate = (alias: string): Gate => ({
    admission: cloudAllowed.pipe(
      Effect.map((allowed): Admission => ({ state: allowed ? "allowed" : "withdrawn" })),
    ),
    join: (scope) => membership.joinProvisioned(scope, alias, cloudAllowed),
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
        consents.forget(alias).pipe(Effect.andThen(discard(alias))),
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
    // A running job sees the withdrawal itself; an old failure no longer applies.
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
    const fiber = yield* release(alias).pipe(
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
    cause !== "removed" ? Effect.void : discard(alias).pipe(Effect.andThen(startRelease(alias))),
  );
  // Releases that failed, or never ran, before this start.
  yield* membership.pendingReleases.pipe(
    Effect.flatMap((aliases) => Effect.forEach(aliases, startRelease, { discard: true })),
    Effect.ignore({ log: true }),
  );

  return OpenCodexChildBootstrap.of({
    ensure,
    status: (alias) => Ref.get(records).pipe(Effect.map((current) => current[alias])),
    setSshOptIn,
    sshOptIn,
  });
});

export const layer = Layer.effect(OpenCodexChildBootstrap, make);
