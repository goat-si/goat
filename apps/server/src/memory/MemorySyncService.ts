// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned submission IDs.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import { resolveMemoryModelSelection } from "@goat/shared/serverSettings";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Client from "./MemoryHubClient.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import * as Hold from "./MemoryGenerationHold.ts";
import * as Quota from "./MemoryQuotaService.ts";
import { memoryOperationDigest } from "./MemoryDecider.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";
import { redactGoatCredentials } from "../mcp/goatCredentialRedaction.ts";
import * as OwnerSource from "./MemoryOwnerSourceReader.ts";

type Error = Hub.MemoryHubServiceError;
type Permit = Effect.Effect<void, Service.MemoryAccessError>;
type Bootstrap = {
  state: "unbound" | "staging" | "ready";
  checkpointId: string | null;
  snapshotToken: string | null;
  checkpointSequence: number;
  cursor: string | null;
  pageCount: number;
};
/** Application-owned committed reads and authorization; never a transport or Worker reader. */
export class MemorySyncRuntime extends Context.Service<
  MemorySyncRuntime,
  {
    readonly cwd: string;
    /** SQL-free committed authority; absent until the application snapshot adapter is wired. */
    readonly readIntentBinding?: Effect.Effect<Service.IntentBinding, Service.MemoryAccessError>;
    /** Application observations, never inferred from a timer: credential, descriptor or reconnect. */
    readonly rearmEvents?: Stream.Stream<
      {
        /** Committed authority at observation, never retagged at delivery. */
        epoch: number;
        memorySpaceId: M.MemorySpaceId;
        hubEnvironmentId: M.EnvironmentId;
        holdClass: Store.MemoryHoldClass;
      },
      Service.MemoryAccessError
    >;
    readonly readBootstrap: (
      space: M.MemorySpaceId,
      hub: M.EnvironmentId,
    ) => Effect.Effect<Bootstrap, Service.MemoryServiceError>;
    readonly discardBootstrap: (
      space: M.MemorySpaceId,
      hub: M.EnvironmentId,
      token: string,
    ) => Effect.Effect<void, Service.MemoryServiceError>;
    readonly readProcessing: (
      space: M.MemorySpaceId | null,
      hub: M.EnvironmentId | null,
    ) => Effect.Effect<
      {
        processing: M.MemoryProcessingStatus;
        pendingSync: number;
        quarantined: number;
        parked: number;
      },
      Store.MemoryStorageError
    >;
    /** Counter-backed global/local storage snapshot when no space is bound. */
    readonly readUnboundStorage: Effect.Effect<M.MemoryStorageStatus, Store.MemoryStorageError>;
    readonly available: (
      selection: M.MemoryModelSelection,
    ) => Effect.Effect<void, M.MemoryHubError>;
    readonly ownerPolicy?: OwnerSource.MemoryOwnerSourceReadPolicyPort["Service"];
    readonly ownerPermit: (request: M.MemorySourceReadRequest) => Permit;
    readonly ownerReader: Service.MemoryOwnerCommittedReader &
      Partial<Pick<OwnerSource.MemoryOwnerSourceReader["Service"]["reader"], "readForRelay">>;
  }
>()("goat/memory/MemorySyncService/MemorySyncRuntime") {}

export class MemorySyncService extends Context.Service<
  MemorySyncService,
  {
    readonly start: Effect.Effect<void, Error>;
    readonly initializeDefaultHub: Effect.Effect<void, Hub.MemoryHubAdministrationError | Error>;
    readonly syncOnce: Effect.Effect<void, Error>;
    readonly shutdown: Effect.Effect<void>;
    readonly scheduleConflictResolution: Effect.Effect<void, Error>;
    readonly readLocalReadiness: () => Effect.Effect<
      { memorySpaceId: M.MemorySpaceId | null; bootstrap: "unbound" | "staging" | "ready" },
      Error
    >;
    readonly requireBootstrap: (space: M.MemorySpaceId) => Effect.Effect<void, Error>;
    readonly syncStatus: (
      input: M.MemorySyncStatusInput,
      permit: Permit,
    ) => Effect.Effect<M.MemorySyncStatus, Error>;
    readonly hubDiagnostics: (
      input: M.MemorySyncStatusInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryHubDiagnostics, Error>;
    readonly reconcileHub: (
      input: M.MemoryHubReconcileInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryHubReconcileResult, Error>;
    readonly getHubSettings: (
      input: M.MemoryHubSettingsGetInput,
      permit: Permit,
    ) => Effect.Effect<M.MemoryHubSettingsView, Error>;
    readonly updateHubSettings: (
      input: M.MemoryHubSettingsUpdateInput,
      permit: Permit,
    ) => Effect.Effect<
      M.MemoryHubSettingsUpdateResult,
      Hub.MemoryHubAdministrationError | Service.MemoryAccessError
    >;
    readonly readSource: Service.MemorySourceReadAuthority["readSource"];
    readonly activeResolutions: Effect.Effect<number>;
  }
>()("goat/memory/MemorySyncService") {}

const iso = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));
const uuid = () => NodeCrypto.randomUUID();
const stableId = (attempt: string, kind: string) => {
  const h = NodeCrypto.createHash("sha256").update(`${attempt}:${kind}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const sameHeads = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((h, i) => h === [...b].sort()[i]);
const selectionKey = Schema.encodeSync(Schema.fromJsonString(M.MemoryModelSelection));
// New conflict claims freeze the memory model; frozen tickets keep theirs across devices.
const memorySelection = (s: M.ServerSettings) =>
  s.memoryEnabled ? resolveMemoryModelSelection(s, undefined) : null;
const decodeMemorySelection = Schema.decodeUnknownEffect(M.MemoryModelSelection);
const decodePull = Schema.decodeUnknownEffect(M.MemoryHubPullResult);
const decodeSource = Schema.decodeUnknownEffect(M.MemorySourceReadOutcome);
const decodeGenerated = Schema.decodeUnknownEffect(M.ResolveMemoryConflictExecutionResult);
const decodeResolveInput = Schema.decodeUnknownEffect(M.ResolveMemoryConflictInput);
const decodeLineagePayload = Schema.decodeUnknownEffect(M.MemoryPayload);
const decodeSubmission = Schema.decodeUnknownEffect(M.MemoryHubApplyResolutionInput);
const encodePush = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubPushInput));
const failureCode = (e: Error): M.MemoryFailureCode =>
  e._tag === "MemoryHubUnauthorizedError" || e._tag === "MemoryHubForbiddenError"
    ? "route_unavailable"
    : e._tag === "MemoryStorageError"
      ? "storage_failed"
      : e._tag === "MemoryCapacityError"
        ? "capacity_exceeded"
        : e.code;
const holdClass = (e: Error): Store.MemoryHoldClass =>
  e._tag === "MemoryHubUnauthorizedError" ||
  e._tag === "MemoryHubForbiddenError" ||
  failureCode(e) === "route_unavailable"
    ? "authorization"
    : ["identity_mismatch", "space_mismatch"].includes(failureCode(e))
      ? "identity"
      : [
            "unsupported_protocol",
            "unsupported_operation",
            "invalid_output",
            "invalid_cursor",
          ].includes(failureCode(e))
        ? "protocol"
        : "availability";
const HELD_CLAIM_DEFER_MS = 60_000;
const transient = (e: Error) =>
  e._tag === "MemoryStorageError" ||
  (e._tag === "MemoryHubError" &&
    ["unavailable", "storage_failed", "cursor_expired"].includes(e.code));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store.MemoryStore;
  const service = yield* Service.MemoryService;
  const client = yield* Client.MemoryHubClient;
  const hub = yield* Hub.MemoryHubService;
  const settings = yield* Settings.ServerSettingsService;
  const committedSettings = yield* Settings.MemoryHubCommittedSettings;
  const runtime = yield* MemorySyncRuntime;
  const quota = yield* Quota.MemoryQuotaService;
  const generation = yield* Generation.TextGeneration;
  const hold = yield* Hold.shared;
  const identity = yield* Environment.ServerEnvironmentIdentity;
  const local = yield* identity.getEnvironmentId;
  const scope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const coordinator = yield* Semaphore.make(1);
  let cycle: Fiber.Fiber<void, Error> | null = null;
  let pendingSweep = false;
  let pendingSync = false;
  let cancelling = false;
  let statusEpoch: number | null = null;
  const registryMutex = yield* Semaphore.make(1);
  const owner = uuid();
  let stopped = false;
  let started = false;
  let pullRetryChanged = yield* Deferred.make<void>();
  const wakePullRetry = Effect.suspend(() => Deferred.succeed(pullRetryChanged, undefined));
  let reservations = 0;
  let lastSuccess: { epoch: number; at: string } | null = null;
  let lastFailure: { epoch: number; code: M.MemoryFailureCode } | undefined;
  const background: Fiber.Fiber<void, never>[] = [];
  // Slots remain reserved through persistence and bounded release in the outer finalizer.
  const executions = new Map<
    string,
    { epoch: number; ticket: M.MemoryResolutionLease; fiber: Fiber.Fiber<void, never> | null }
  >();
  const readSettings = settings.getSettings.pipe(
    Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
  );
  const initialSettings = yield* readSettings;
  let settingsEpoch = initialSettings.memoryHubVersion;
  const bindingKey = (s: typeof initialSettings) => ({
    space: s.memoryHub.mode === "disabled" ? null : s.memoryHub.memorySpaceId,
    mode: s.memoryHub.mode,
    hub: s.memoryHub.mode === "member" ? s.memoryHub.hubEnvironmentId : local,
    endpoint: s.memoryHub.mode === "member" ? s.memoryHub.endpoint : null,
    credential: s.memoryHub.mode === "member" ? s.memoryHub.secretName : null,
    model: memorySelection(s) ? selectionKey(memorySelection(s)!) : null,
    epoch: s.memoryHubVersion,
  });
  let previousBinding = bindingKey(initialSettings);
  // One current binding, four classes, two keyset cursors per class.
  const rearms = new Map<
    Store.MemoryHoldClass,
    {
      epoch: number;
      space: M.MemorySpaceId;
      syncAfter: string;
      resolutionAfter: string;
      syncDone: boolean;
      resolutionDone: boolean;
      restartRequested: boolean;
      permit?: Permit;
    }
  >();
  const enqueueRearm = (
    epoch: number,
    space: M.MemorySpaceId,
    classes: readonly Store.MemoryHoldClass[],
    permit?: Permit,
  ) => {
    for (const c of classes) {
      const pending = rearms.get(c);
      if (!pending || pending.epoch !== epoch || pending.space !== space)
        rearms.set(c, {
          epoch,
          space,
          syncAfter: "",
          resolutionAfter: "",
          syncDone: false,
          resolutionDone: false,
          restartRequested: false,
          ...(permit ? { permit } : {}),
        });
      else {
        pending.restartRequested = true;
        if (permit) pending.permit = permit;
        else delete pending.permit;
      }
    }
  };
  const ensureEpoch = (epoch: number): Permit =>
    committedSettings.read.pipe(
      Effect.flatMap((s) =>
        s.version === epoch && !stopped
          ? Effect.void
          : Effect.fail(new Service.MemoryAccessError({ code: "fenced" })),
      ),
      Effect.mapError(() => new Service.MemoryAccessError({ code: "fenced" })),
    );
  const resetStatus = (epoch: number) => {
    if (statusEpoch !== epoch) {
      statusEpoch = epoch;
      lastFailure = undefined;

      lastSuccess = null;
    }
  };
  const noteFailure = Effect.fn("MemorySyncService.noteFailure")(
    function* (epoch: number, error: Error) {
      const s = yield* committedSettings.read;
      if (!stopped && s.version === epoch) {
        resetStatus(epoch);
        lastFailure = { epoch, code: failureCode(error) };
      }
    },
    (effect) => Effect.ignore(effect),
  );
  const route = Effect.fnUntraced(function* () {
    const s = yield* readSettings;
    if (s.memoryHub.mode === "disabled") return null;
    const principal =
      s.memoryHub.mode === "hub" && s.memoryHub.memorySpaceId !== null
        ? yield* store.readHubMember(s.memoryHub.memorySpaceId, local)
        : undefined;
    if (s.memoryHub.mode === "hub" && !principal)
      return yield* new M.MemoryHubError({ code: "bootstrap_required" });
    const connection: Client.HubConnection | null =
      s.memoryHub.mode === "member" ? { ...s.memoryHub, epoch: s.memoryHubVersion } : null;
    const p: M.MemoryHubPrincipal | null = principal
      ? {
          memorySpaceId: principal.memorySpaceId,
          environmentId: local,
          credentialVersion: principal.credentialVersion,
          scopes: ["memory:sync"],
        }
      : null;
    return {
      settings: s,
      connection,
      principal: p,
      hubId: connection?.hubEnvironmentId ?? local,
      space: s.memoryHub.memorySpaceId,
    };
  });
  type Route = NonNullable<Effect.Success<ReturnType<typeof route>>>;
  const writeLastReadySpace = (space: M.MemorySpaceId) =>
    sql`INSERT INTO memory_last_ready_space(singleton,space) VALUES (1,${space})
      ON CONFLICT(singleton) DO UPDATE SET space=excluded.space WHERE space!=excluded.space`.pipe(
      Effect.mapError(
        (cause) => new Store.MemoryStorageError({ stage: "last-ready-space", cause }),
      ),
    );
  // Already-ready bindings from before 080 are also observed by sync, without a status read.
  let rememberedReadyEpoch: number | undefined;
  const rememberReadySpace = Effect.fnUntraced(function* (r: Pick<Route, "space" | "settings">) {
    if (!r.space || rememberedReadyEpoch === r.settings.memoryHubVersion) return;
    yield* store.transact(
      ensureEpoch(r.settings.memoryHubVersion).pipe(Effect.andThen(writeLastReadySpace(r.space))),
      { finalGuard: ensureEpoch(r.settings.memoryHubVersion) },
    );
    rememberedReadyEpoch = r.settings.memoryHubVersion;
  });
  const readRetainedSpace = Effect.gen(function* () {
    const read = sql<{
      space: string;
    }>`SELECT space FROM memory_last_ready_space WHERE singleton=1`;
    const rows = yield* read;
    if (rows[0]) return M.MemorySpaceId.make(rows[0].space);
    const candidates =
      yield* sql`SELECT 1 FROM memory_sync_cursors WHERE bootstrap_state='ready' LIMIT 1`;
    if (!candidates[0]) return null;
    // Legacy cursors have no ready timestamp. Prefer retained memories, then successful sync
    // and memory activity, with a stable space-id tie-break. Never replace a saved destination.
    return yield* store.transact(
      Effect.gen(function* () {
        yield* sql`INSERT INTO memory_last_ready_space(singleton,space)
          SELECT 1,c.space FROM memory_sync_cursors AS c
          WHERE c.bootstrap_state='ready'
            AND NOT EXISTS (SELECT 1 FROM memory_last_ready_space WHERE singleton=1)
          GROUP BY c.space ORDER BY
            EXISTS (SELECT 1 FROM memory_items AS i WHERE i.space=c.space AND i.status!='forgotten') DESC,
            max(c.last_success_at) DESC,
            (SELECT max(r.created_at) FROM memory_revisions AS r WHERE r.space=c.space) DESC,
            c.space ASC LIMIT 1`;
        const recovered = yield* read;
        return recovered[0] ? M.MemorySpaceId.make(recovered[0].space) : null;
      }),
    );
  }).pipe(
    Effect.mapError(
      (cause) => new Store.MemoryStorageError({ stage: "retained-local-space", cause }),
    ),
  );
  // At most three descriptor-recoverable classes and one probe fiber per committed epoch.
  const recoveries = new Map<
    Store.MemoryHoldClass,
    { generation: number; route: Route; delay: number; due: number }
  >();
  // Never reset on epoch cancellation: an old probe cannot settle a later registration.
  let recoveryGeneration = 0;
  let recoveryFiber: Fiber.Fiber<void, never> | null = null;
  let recoveryChanged = yield* Deferred.make<void>();
  const wakeRecovery = Effect.suspend(() => Deferred.succeed(recoveryChanged, undefined));
  const scheduleRecovery = (
    r: Route,
    c: Store.MemoryHoldClass | null,
    supersede = true,
  ): Effect.Effect<void, Service.MemoryAccessError> =>
    Effect.gen(function* () {
      if (!started || stopped || cancelling || !r.connection || !c || c === "authorization") return;
      const now = yield* Clock.currentTimeMillis;
      yield* ensureEpoch(r.settings.memoryHubVersion);
      if (stopped || cancelling) return;
      const previous = recoveries.get(c);
      // Persisted presence only coalesces; each new failure supersedes an in-flight
      // observation, preserving accumulated backoff.
      // Coalesce the class into one slot, but leave at least 30s for its next real probe.
      if (!previous || supersede)
        recoveries.set(c, {
          generation: ++recoveryGeneration,
          route: r,
          delay: previous?.delay ?? 30000,
          due: Math.max(previous?.due ?? 0, now + 30000),
        });
      if (recoveryFiber) {
        yield* wakeRecovery;
        return;
      }
      const ready = yield* Deferred.make<void>();
      const fiber = yield* Deferred.await(ready).pipe(
        Effect.andThen(Effect.suspend(() => recoveryLoop)),
        Effect.ensuring(
          Effect.sync(() => {
            recoveryFiber = null;
          }),
        ),
        Effect.forkIn(scope),
      );
      recoveryFiber = fiber;
      yield* Deferred.succeed(ready, undefined);
      // Cancellation may have captured the probe before forkIn published this fiber.
      // Finish the start gate, then retire that late publication before returning.
      if (stopped || cancelling) yield* Fiber.interrupt(fiber);
    }).pipe(Effect.uninterruptible);
  let discoveryEpoch: number | null = null;
  let discoveryFailure: Store.MemoryStorageError | null = null;
  // The cycle mutex serializes discovery with sync. Presence only registers a real probe;
  // it is never a successful observation or permission to rearm persisted work.
  const discoverRecoveries = (r: Route) =>
    Effect.gen(function* () {
      if (!started || !r.connection || !r.space || discoveryEpoch === r.settings.memoryHubVersion)
        return;
      yield* ensureEpoch(r.settings.memoryHubVersion);
      discoveryEpoch = r.settings.memoryHubVersion;
      discoveryFailure = null;
      const classes = yield* store.readPersistedHoldClasses({
        memorySpaceId: r.space,
        hubEnvironmentId: r.hubId,
      });
      yield* ensureEpoch(r.settings.memoryHubVersion);
      for (const c of classes) yield* scheduleRecovery(r, c, false);
    }).pipe(
      Effect.catch((error) => {
        if (error._tag === "MemoryStorageError") discoveryFailure = error;
        return noteFailure(r.settings.memoryHubVersion, error);
      }),
    );
  const callPull = (r: Route, i: M.MemoryHubPullInput) =>
    r.connection ? client.pull(r.connection, i) : hub.pull(i, r.principal!);
  const release = (r: Route, ticket: M.MemoryResolutionLease) => {
    const input: M.MemoryHubReleaseInput = {
      protocolVersion: 1,
      memorySpaceId: ticket.memorySpaceId,
      memoryId: ticket.memoryId,
      conflictId: ticket.conflictId,
      holderEnvironmentId: local,
      attemptId: ticket.attemptId,
      fencingToken: ticket.fencingToken,
    };
    return (
      r.connection ? client.release(r.connection, input) : hub.release(input, r.principal!)
    ).pipe(
      Effect.interruptible,
      Effect.timeout("15 seconds"),
      Effect.map((result) => result.released),
      // The Hub answers fenced when it holds no lease for this attempt, for example after a
      // release whose response was lost; nothing is held, so callers may retire the attempt.
      // The client raises the same code locally once settings no longer bind this connection,
      // which proves nothing about the lease.
      Effect.catch((error) =>
        error._tag === "MemoryHubError" && error.code === "fenced"
          ? readSettings.pipe(
              Effect.map((current) =>
                r.connection
                  ? Client.isCurrentConnection(current, r.connection)
                  : current.memoryHubVersion === r.settings.memoryHubVersion,
              ),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false),
      ),
    );
  };
  const eligibility = Effect.fnUntraced(function* (ticket: M.MemoryResolutionLease) {
    const aggregate = yield* store.readResolutionSnapshot(ticket.memorySpaceId, ticket.memoryId);
    if (
      aggregate.tombstone ||
      aggregate.pendingForget ||
      !sameHeads(aggregate.heads, ticket.conflictHeadSet) ||
      aggregate.status !== "quarantined" ||
      aggregate.reasons.some((r) =>
        [
          "secret_detected",
          "scanner_pending",
          "missing_parent",
          "dependency_invalidated",
          "forget_pending",
        ].includes(r),
      )
    )
      return yield* new M.MemoryHubError({ code: "conflict_changed" });
    return aggregate;
  });
  const ownership = (row: Store.TicketRow): Store.TicketOwner => ({
    memorySpaceId: row.ticket.memorySpaceId,
    attemptId: row.ticket.attemptId,
    owner,
    coordinatorEpoch: row.coordinatorEpoch,
    version: row.version,
  });

  const runClaimedResolution = Effect.fn("MemorySyncService.runClaimedResolution")(function* (
    r: Route,
    initial: Store.TicketRow,
    candidate: {
      candidateId: string;
      expectedGeneration: number;
      expectedAttempt: number;
    } | null,
  ) {
    let row = initial;
    let currentLease = initial.ticket;
    let renewalFailed = false;
    let authoritativeExpiry = Date.parse(initial.ticket.expiresAtHubTime);
    let definitiveFailure = false;
    let generationAttempted = false;
    let failureRecorded = false;
    const transition = Effect.fnUntraced(function* (
      state: Store.TicketState,
      approval?: M.MemoryHubReceipt,
      retireClaim?: { expectedGeneration: number; attemptId: string },
      relinquish = false,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const next = yield* store.transact(
        store.transitionResolutionTicketTx({
          ownership: ownership(row),
          nextState: state,
          now,
          ownedUntil:
            relinquish || state === "terminal" || state === "recoverable" || state === "submitting"
              ? null
              : now + 60000,
          nextAttemptAt: Math.max(
            renewalFailed ? authoritativeExpiry : 0,
            now +
              (relinquish || retireClaim || state === "recoverable" || state === "submitting"
                ? 30000
                : 0),
          ),
          ...(approval ? { approval } : {}),
          ...(retireClaim ? { retireClaim } : {}),
        }),
      );
      if (!next) return yield* new M.MemoryHubError({ code: "fenced" });
      row = { ...next, ticket: currentLease };
    });
    const refreshLease = Effect.fnUntraced(function* () {
      const current = currentLease;
      const input: M.MemoryHubRenewInput = {
        protocolVersion: 1,
        memorySpaceId: current.memorySpaceId,
        memoryId: current.memoryId,
        conflictId: current.conflictId,
        holderEnvironmentId: local,
        attemptId: current.attemptId,
        fencingToken: current.fencingToken,
      };
      const renewed = yield* (
        r.connection ? client.renew(r.connection, input) : hub.renew(input, r.principal!)
      ).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            renewalFailed = true;
          }),
        ),
      );

      yield* ensureEpoch(r.settings.memoryHubVersion);
      if (
        renewed.memorySpaceId !== current.memorySpaceId ||
        renewed.memoryId !== current.memoryId ||
        renewed.conflictId !== current.conflictId ||
        renewed.holderEnvironmentId !== local ||
        renewed.attemptId !== current.attemptId ||
        renewed.fencingToken !== current.fencingToken ||
        renewed.claimedAtHubTime !== current.claimedAtHubTime ||
        renewed.attemptDeadlineHubTime !== current.attemptDeadlineHubTime ||
        !sameHeads(renewed.conflictHeadSet, current.conflictHeadSet) ||
        selectionKey(renewed.frozenDefaultModelSelection) !==
          selectionKey(current.frozenDefaultModelSelection)
      )
        return yield* new M.MemoryHubError({ code: "fenced" });
      // Hub authority survives a failed local write; keep the persisted lease for subsequent CAS.
      authoritativeExpiry = Math.max(authoritativeExpiry, Date.parse(renewed.expiresAtHubTime));
      renewalFailed = true;
      const persisted = yield* store.transact(
        store.renewResolutionTicketTx({
          ownership: ownership(row),
          now: yield* Clock.currentTimeMillis,
          expectedExpiresAtHubTime: current.expiresAtHubTime,
          renewedLease: renewed,
        }),
      );
      if (!persisted) return yield* new M.MemoryHubError({ code: "fenced" });
      renewalFailed = false;
      currentLease = renewed;
      row = persisted;
      const slot = executions.get(renewed.memoryId);
      if (slot) slot.ticket = renewed;
    });
    const reconcile = Effect.fnUntraced(function* (rejection?: M.MemoryHubReceipt) {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* store.transact(
        Effect.gen(function* () {
          const candidate = yield* store.findClaimCandidate({
            memorySpaceId: row.ticket.memorySpaceId,
            attemptId: row.ticket.attemptId,
          });
          const reconciled = yield* service.reconcileResolutionSubmission({
            ownership: ownership(row),
            now,
            hubEnvironmentId: r.hubId,
            localEnvironmentId: local,
            reauthorize: ensureEpoch(r.settings.memoryHubVersion),
            ...(rejection ? { rejection } : {}),
          });
          // Preserve the coordinator's retry budget in the same writer transaction as retirement.
          if (reconciled?.outcome === "retired" && candidate)
            yield* store.retryClaimCandidate(
              candidate.id,
              now + 30000,
              rejection?.failureCode ?? "conflict_changed",
            );
          return reconciled;
        }),
      );
      if (!result) return yield* new M.MemoryHubError({ code: "fenced" });
      row = result.row;
      return result.outcome;
    });
    const execute = Effect.gen(function* () {
      yield* ensureEpoch(r.settings.memoryHubVersion);
      // Approval metadata alone cannot justify creating replacement bytes.
      if (!row.submission && (row.approval || row.reconcileRequired))
        return yield* new M.MemoryHubError({ code: "invalid_output" });
      // Reconcile durable bytes before inspecting the new frontier or generating another result.
      if (row.submission) {
        if ((yield* reconcile()) !== "uncertain") return;
      }
      if (!row.submission) {
        yield* transition("running");
        yield* refreshLease();
        const snapshot = yield* eligibility(row.ticket);
        yield* runtime.available(row.ticket.frozenDefaultModelSelection);
        const revisions = yield* store.readResolutionHeads({
          memorySpaceId: row.ticket.memorySpaceId,
          memoryId: row.ticket.memoryId,
          heads: row.ticket.conflictHeadSet,
          expectedGeneration: snapshot.generation,
          maxItems: 100,
          maxBytes: M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
        });
        if (
          revisions.length !== row.ticket.conflictHeadSet.length ||
          revisions.some((h) => h.payload === null)
        )
          return yield* new M.MemoryHubError({ code: "missing_parent" });
        const heads = revisions
          .filter(
            (h) => row.ticket.conflictHeadSet.includes(h.revision.revisionId) && h.payload !== null,
          )
          .map((h) => ({ revision: h.revision, payload: h.payload! }));
        const inheritedDependencies = [
          ...new Set(heads.flatMap((h) => h.payload.derivedFromMemoryRevisions)),
        ];
        const dependencies = [
          ...new Set([...row.ticket.conflictHeadSet, ...inheritedDependencies]),
        ];
        // Check the existing payload codec's dependency/byte bounds before generation.
        const lineage = yield* decodeLineagePayload({
          text: "lineage admission",
          evidence: [],
          derivedFromMemoryRevisions: dependencies,
        }).pipe(Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })));
        const recheckDependencies = Service.validateSummaryDependencies(
          row.ticket.memorySpaceId,
          {
            ...lineage,
            derivedFromMemoryRevisions: inheritedDependencies.filter(
              (id) => !row.ticket.conflictHeadSet.includes(id),
            ),
          },
          { memoryId: row.ticket.memoryId, revisions: dependencies },
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        yield* recheckDependencies;
        const input = yield* decodeResolveInput({
          cwd: runtime.cwd,
          memorySpaceId: row.ticket.memorySpaceId,
          memoryId: row.ticket.memoryId,
          conflictId: row.ticket.conflictId,
          heads,
          modelSelection: row.ticket.frozenDefaultModelSelection,
        }).pipe(Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })));
        const model = generation.resolveMemoryConflict;
        if (!model) return yield* new M.MemoryHubError({ code: "route_unavailable" });
        const renew = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep("30 seconds");
            yield* ensureEpoch(r.settings.memoryHubVersion);
            yield* eligibility(row.ticket);
            yield* refreshLease();
            yield* transition("running");
          }
        });
        yield* ensureEpoch(r.settings.memoryHubVersion);
        yield* eligibility(row.ticket);
        generationAttempted = true;
        const holdKey = yield* hold.keyFor(input.modelSelection);
        const generated = yield* Effect.scoped(
          Effect.gen(function* () {
            // Renewal failure interrupts the provider, including a hung one-shot execution.
            return yield* Effect.raceFirst(
              hold.guard(holdKey, model(input)).pipe(
                // A held model or a refusal that repeats retires this attempt without a failure
                // report (generation_failed is definitive but unreported): its lease is released
                // and the conflict is claimed again once the model is no longer held.
                Effect.mapError(
                  (error) =>
                    new M.MemoryHubError({
                      code:
                        error._tag === "MemoryGenerationHeld" ||
                        Hold.deterministicFailure(error) !== undefined
                          ? "generation_failed"
                          : "invalid_output",
                    }),
                ),
              ),
              renew.pipe(Effect.flatMap(() => Effect.never)),
            );
          }),
        ).pipe(
          // Member time schedules cancellation only; Hub remains the admission authority.
          Effect.timeout(
            Math.max(
              0,
              Date.parse(currentLease.attemptDeadlineHubTime) - (yield* Clock.currentTimeMillis),
            ),
          ),
          Effect.catchTags({
            TimeoutError: () => Effect.fail(new M.MemoryHubError({ code: "lease_expired" })),
          }),
        );
        const decoded = yield* decodeGenerated(generated).pipe(
          Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
        );
        // A model can repeat a GOAT credential it read; the resolution is submitted and signed
        // with it redacted (#1297).
        const trusted = {
          ...decoded,
          result: {
            ...decoded.result,
            text: redactGoatCredentials(decoded.result.text),
            judgment: redactGoatCredentials(decoded.result.judgment),
          },
        };
        if (
          trusted.execution.environmentId !== local ||
          selectionKey(trusted.execution.requestedModelSelection) !==
            selectionKey(row.ticket.frozenDefaultModelSelection) ||
          !M.validateMemoryGenerationResult(input, trusted.result) ||
          scanMemoryValue(trusted.result).kind !== "allowed"
        )
          return yield* new M.MemoryHubError({ code: "invalid_output" });
        yield* ensureEpoch(r.settings.memoryHubVersion);
        yield* eligibility(row.ticket);
        const now = yield* Clock.currentTimeMillis;
        const operationId = M.MemoryOperationId.make(stableId(row.ticket.attemptId, "operation"));
        const revisionId = M.MemoryRevisionId.make(stableId(row.ticket.attemptId, "revision"));
        const resolutionId = M.MemoryResolutionId.make(
          stableId(row.ticket.attemptId, "resolution"),
        );
        const submission = yield* decodeSubmission({
          protocolVersion: 1,
          memorySpaceId: row.ticket.memorySpaceId,
          holderEnvironmentId: local,
          attemptId: row.ticket.attemptId,
          operation: {
            protocolVersion: 1,
            operationId,
            memorySpaceId: row.ticket.memorySpaceId,
            originEnvironmentId: local,
            memoryId: row.ticket.memoryId,
            expectedHeads: row.ticket.conflictHeadSet,
            kind: "resolve",
            conflictId: row.ticket.conflictId,
            fencingToken: row.ticket.fencingToken,
            revision: {
              memorySpaceId: row.ticket.memorySpaceId,
              memoryId: row.ticket.memoryId,
              operationId,
              revisionId,
              payloadRef: revisionId,
              parents: row.ticket.conflictHeadSet,
              scope: heads[0]!.revision.scope,
              assertionKind: trusted.result.assertionKind,
              provenance: {
                environmentId: local,
                providerInstanceId: trusted.execution.providerInstanceId,
                provider: trusted.execution.effectiveProvider,
                requestedModelSelection: row.ticket.frozenDefaultModelSelection,
                effectiveModel: trusted.execution.effectiveModel,
              },
              createdAtUtc: iso(now),
            },
            payload: {
              text: trusted.result.text,
              evidence: trusted.result.evidence,
              derivedFromMemoryRevisions: dependencies,
            },
            resolution: {
              resolutionId,
              memorySpaceId: row.ticket.memorySpaceId,
              memoryId: row.ticket.memoryId,
              inputRevisionIds: row.ticket.conflictHeadSet,
              inputPayloadRefs: row.ticket.conflictHeadSet.map(
                (id) => heads.find((head) => head.revision.revisionId === id)!.revision.payloadRef,
              ),
              judgmentRef: resolutionId,
              requestedModelSelection: row.ticket.frozenDefaultModelSelection,
              effectiveProvider: trusted.execution.effectiveProvider,
              effectiveModel: trusted.execution.effectiveModel,
              resolvingEnvironmentId: local,
              fencingToken: row.ticket.fencingToken,
              resultRevisionId: revisionId,
              appliedAtUtc: iso(now),
              revertDeadlineUtc: iso(now + M.MEMORY_REVERT_WINDOW_MS),
            },
            resolutionPayload: { resolutionId, judgment: trusted.result.judgment },
          },
        }).pipe(Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })));
        row = yield* store.transact(
          Effect.gen(function* () {
            yield* recheckDependencies;
            return yield* store.persistResolutionSubmissionTx({
              ownership: ownership(row),
              submission,
              digest: memoryOperationDigest(submission.operation),
            });
          }),
        );
      }
      yield* ensureEpoch(r.settings.memoryHubVersion);
      const receipt = yield* r.connection
        ? client.applyResolution(r.connection, row.submission!)
        : hub.applyResolution(row.submission!, r.principal!);
      if (receipt.outcome === "rejected" || receipt.hubSequence === null) {
        if (receipt.outcome !== "rejected")
          return yield* new M.MemoryHubError({ code: "invalid_output" });
        if ((yield* reconcile(receipt)) === "uncertain")
          return yield* new M.MemoryHubError({ code: "invalid_output" });
        return;
      }
      yield* transition("approved", receipt);
      yield* reconcile();
    });
    yield* execute.pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          definitiveFailure = !row.submission && !row.approval && !transient(error);
          if (row.approval || row.state === "terminal") return;
          yield* ensureEpoch(r.settings.memoryHubVersion);
          const now = yield* Clock.currentTimeMillis;
          const permanentClass = holdClass(error);
          if (definitiveFailure && ["authorization", "identity"].includes(permanentClass)) {
            // A stale/protected pair must not fall back to ticket-only hold or retirement.
            // The candidate acquisition lineage was captured with ticket ownership.
            failureRecorded = true;
            const held = yield* store.transact(
              Effect.gen(function* () {
                yield* ensureEpoch(r.settings.memoryHubVersion);
                if (!candidate) return null;
                return yield* store.holdResolutionAttemptTx({
                  ownership: ownership(row),
                  ...candidate,
                  now,
                  failureCode: failureCode(error),
                  holdClass: permanentClass,
                });
              }),
            );
            if (held) {
              row = held;
              yield* scheduleRecovery(r, permanentClass);
            }
            return;
          }
          const failed = yield* store.transact(
            Effect.gen(function* () {
              const saved = yield* store.failResolutionTicketTx({
                ownership: ownership(row),
                now,
                failureCode: failureCode(error),
                nextAttemptAt: definitiveFailure
                  ? now
                  : Math.max(now + 30000, renewalFailed ? authoritativeExpiry : 0),
                reportConflictFailure:
                  definitiveFailure &&
                  generationAttempted &&
                  !renewalFailed &&
                  ["invalid_output", "lease_expired"].includes(failureCode(error)),
              });
              if (!saved || !definitiveFailure) return saved;
              // Keep definitive retirement and its report in the same local owner lineage.
              const acquired = yield* store.acquireResolutionTicketTx({
                key: {
                  memorySpaceId: saved.ticket.memorySpaceId,
                  attemptId: saved.ticket.attemptId,
                },
                expectedVersion: saved.version,
                owner,
                coordinatorEpoch: r.settings.memoryHubVersion,
                now,
                ownedUntil: now + 60000,
              });
              if (!acquired) return yield* new M.MemoryHubError({ code: "fenced" });
              return acquired;
            }),
          );
          if (failed) {
            row = failed;
            failureRecorded = !definitiveFailure;
          }
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          const released = yield* release(r, row.ticket);
          if (failureRecorded) return;
          if (row.state !== "terminal") {
            if (definitiveFailure && released) {
              const candidate = yield* store.findClaimCandidate({
                memorySpaceId: row.ticket.memorySpaceId,
                attemptId: row.ticket.attemptId,
              });
              if (candidate?.metadata.kind === "claim") {
                const retired = yield* Effect.result(
                  transition("terminal", undefined, {
                    expectedGeneration: candidate.metadata.generation ?? 0,
                    attemptId: row.ticket.attemptId,
                  }),
                );
                if (retired._tag === "Success") return;
              }
            }
            {
              // Unknown apply outcomes and known approvals retain the immutable submission.
              yield* transition(
                row.submission ? (row.approval ? "approved" : "submitting") : "recoverable",
                undefined,
                undefined,
                true,
              ).pipe(Effect.ignore);
            }
          }
        }).pipe(Effect.ignore),
      ),
    );
  });

  const register = Effect.fnUntraced(function* (r: Route, saved: Store.TicketRow) {
    if (
      stopped ||
      cancelling ||
      executions.size >= 4 ||
      executions.has(saved.ticket.memoryId) ||
      saved.ticket.holderEnvironmentId !== local ||
      saved.ticket.memorySpaceId !== r.space
    )
      return;
    executions.set(saved.ticket.memoryId, {
      epoch: r.settings.memoryHubVersion,
      ticket: saved.ticket,
      fiber: null,
    });
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const attempt = yield* store.transact(
          Effect.gen(function* () {
            yield* ensureEpoch(r.settings.memoryHubVersion);
            const candidate = yield* store.findClaimCandidate({
              memorySpaceId: saved.ticket.memorySpaceId,
              attemptId: saved.ticket.attemptId,
            });
            const ticket = yield* store.acquireResolutionTicketTx({
              key: { memorySpaceId: saved.ticket.memorySpaceId, attemptId: saved.ticket.attemptId },
              expectedVersion: saved.version,
              owner,
              coordinatorEpoch: r.settings.memoryHubVersion,
              now,
              ownedUntil: now + 60000,
            });
            return {
              ticket,
              candidate:
                candidate?.metadata.kind === "claim"
                  ? {
                      candidateId: candidate.id,
                      expectedGeneration: candidate.metadata.generation ?? 0,
                      expectedAttempt: candidate.attempt,
                    }
                  : null,
            };
          }),
        );
        const acquired = attempt.ticket;
        if (!acquired) {
          executions.delete(saved.ticket.memoryId);
          return;
        }
        if (
          stopped ||
          (yield* Effect.result(ensureEpoch(r.settings.memoryHubVersion)))._tag === "Failure"
        ) {
          yield* store
            .transact(
              store.transitionResolutionTicketTx({
                ownership: ownership(acquired),
                nextState: "recoverable",
                now,
                ownedUntil: null,
                nextAttemptAt: now + 30000,
              }),
            )
            .pipe(Effect.ignore);
          yield* release(r, acquired.ticket);
          executions.delete(saved.ticket.memoryId);
          return;
        }
        const fiber = yield* restore(runClaimedResolution(r, acquired, attempt.candidate)).pipe(
          Effect.catch((e) => noteFailure(r.settings.memoryHubVersion, e)),
          Effect.ensuring(
            Effect.sync(() => {
              executions.delete(saved.ticket.memoryId);
            }),
          ),
          Effect.ensuring(store.wake),
          Effect.ensuring(
            Effect.suspend(() => requestCycle(sweep, true, false)).pipe(
              Effect.ignore,
              Effect.forkIn(scope),
              Effect.asVoid,
            ),
          ),
          Effect.forkIn(scope),
        );
        const slot = executions.get(saved.ticket.memoryId);
        if (slot) slot.fiber = fiber;
      }),
    ).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          executions.delete(saved.ticket.memoryId);
        }),
      ),
    );
  });
  const heldSelection = (selection: unknown) =>
    decodeMemorySelection(selection).pipe(
      Effect.option,
      Effect.flatMap((decoded) =>
        Option.isSome(decoded)
          ? hold.keyFor(decoded.value).pipe(Effect.flatMap(hold.isHeld))
          : Effect.succeed(false),
      ),
    );
  // Moving a held candidate back lets later due candidates (on healthy models) reach the
  // bounded page; a minute keeps a model change from waiting out the old hold.
  const deferHeld = (id: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        store.retryClaimCandidate(id, now + HELD_CLAIM_DEFER_MS, "generation_failed"),
      ),
    );
  const sweep: Effect.Effect<void, Error> = registryMutex.withPermit(
    Effect.gen(function* () {
      const r = yield* route();
      if (!r || !r.space || stopped || cancelling) return;
      yield* ensureEpoch(r.settings.memoryHubVersion);
      const now = yield* Clock.currentTimeMillis;
      // L1 preserves matching tickets and advances a bounded durable frontier cursor.
      yield* store.recoverClaimCandidates(now);
      const saved = yield* store.readRecoverableResolutionTickets({
        memorySpaceId: r.space,
        now,
        limit: 100,
      });
      for (const ticket of saved) yield* register(r, ticket);
      const candidates = yield* store.readDueClaimCandidates(100, now, r.space);
      for (const work of candidates) {
        if (executions.size + reservations >= 4) break;
        if (
          !work.memoryId ||
          executions.has(work.memoryId) ||
          work.metadata.kind !== "claim" ||
          work.space !== r.space
        )
          continue;
        const metadata = work.metadata;
        const prepare = {
          memorySpaceId: r.space,
          candidateId: work.id,
          expectedGeneration: metadata.generation ?? 0,
          conflictHeads: metadata.sortedHeads,
        };
        let reserved = false;
        let claimOwned = false;
        const prepared: { value: Effect.Success<ReturnType<typeof store.prepareClaimAttemptTx>> } =
          { value: null };
        const attempt = yield* Effect.result(
          Effect.gen(function* () {
            let frozen = yield* store.transact(store.prepareClaimAttemptTx(prepare));
            if (!frozen) {
              const selection = memorySelection(yield* readSettings);
              if (!selection) return yield* new M.MemoryHubError({ code: "route_unavailable" });
              // A held model would refuse at once: leave the conflict unclaimed until it is due.
              if (yield* heldSelection(selection)) return yield* deferHeld(work.id);
              yield* runtime.available(selection);
              frozen = yield* store.transact(
                store.prepareClaimAttemptTx({
                  ...prepare,
                  proposedClaim: {
                    protocolVersion: 1,
                    memorySpaceId: r.space!,
                    memoryId: work.memoryId!,
                    conflictId: metadata.conflictId,
                    holderEnvironmentId: local,
                    attemptId: M.MemoryOperationId.make(uuid()),
                    conflictHeadSet: metadata.sortedHeads,
                    frozenDefaultModelSelection: selection,
                  },
                }),
              );
            }
            if (!frozen) return;
            // A claim frozen earlier waits only on its own model.
            if (yield* heldSelection(frozen.claim.frozenDefaultModelSelection))
              return yield* deferHeld(work.id);
            prepared.value = frozen;
            const claimed = yield* store.transact(
              Effect.gen(function* () {
                yield* ensureEpoch(r.settings.memoryHubVersion);
                // A held ticket may be on the next rearm page. Its frozen attempt
                // resumes through ticket recovery without acquiring the candidate again.
                const existing = yield* store.readWork(
                  `resolve:${r.space}:${frozen.claim.attemptId}`,
                );
                if (
                  existing?.metadata.kind === "resolve" &&
                  !["completed", "cancelled", "failed"].includes(existing.status)
                )
                  return false;
                return yield* store.claimCandidate(work.id, r.settings.memoryHubVersion, now);
              }),
            );
            if (!claimed) return;
            claimOwned = true;
            reservations++;
            reserved = true;
            yield* ensureEpoch(r.settings.memoryHubVersion);
            const ticket = yield* r.connection
              ? client.claim(r.connection, frozen.claim)
              : hub.claim(frozen.claim, r.principal!);
            yield* ensureEpoch(r.settings.memoryHubVersion);
            if (
              ticket.memorySpaceId !== r.space ||
              ticket.memoryId !== work.memoryId ||
              ticket.holderEnvironmentId !== local ||
              ticket.conflictId !== frozen.claim.conflictId ||
              ticket.attemptId !== frozen.claim.attemptId ||
              !sameHeads(ticket.conflictHeadSet, frozen.claim.conflictHeadSet) ||
              selectionKey(ticket.frozenDefaultModelSelection) !==
                selectionKey(frozen.claim.frozenDefaultModelSelection)
            )
              return yield* new M.MemoryHubError({ code: "invalid_output" });
            yield* store.persistResolutionTicket(ticket);
            yield* store.retryClaimCandidate(
              work.id,
              Date.parse(ticket.expiresAtHubTime),
              "lease_required",
            );
            reservations--;
            reserved = false;
            for (const row of yield* store.readRecoverableResolutionTickets({
              memorySpaceId: r.space,
              now: yield* Clock.currentTimeMillis,
              limit: 100,
            }))
              if (row.ticket.attemptId === ticket.attemptId) yield* register(r, row);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (reserved) reservations--;
              }),
            ),
          ),
        );
        if (attempt._tag === "Failure") {
          yield* ensureEpoch(r.settings.memoryHubVersion);
          yield* noteFailure(r.settings.memoryHubVersion, attempt.failure);
          const code = failureCode(attempt.failure);
          // Only explicit Hub refusal is proof; transport/storage uncertainty preserves the attempt.
          if (
            prepared.value &&
            attempt.failure._tag === "MemoryHubError" &&
            ["conflict_changed", "lease_expired", "lease_required"].includes(code)
          ) {
            const retired = yield* store.transact(
              store.retireFrozenClaimTx({
                memorySpaceId: r.space,
                candidateId: work.id,
                expectedGeneration: prepared.value.generation,
                attemptId: prepared.value.claim.attemptId,
                frozenHeads: prepared.value.claim.conflictHeadSet,
                nextAttemptAt: now + 30000,
              }),
            );
            if (retired) continue;
          }
          if (
            claimOwned &&
            prepared.value &&
            !transient(attempt.failure) &&
            code !== "claim_busy"
          ) {
            const held = yield* store.transact(
              store.holdClaimCandidateTx({
                memorySpaceId: r.space,
                candidateId: work.id,
                expectedGeneration: prepared.value.generation,
                expectedAttempt: work.attempt + 1,
                attemptId: prepared.value.claim.attemptId,
                coordinatorEpoch: r.settings.memoryHubVersion,
                now: yield* Clock.currentTimeMillis,
                failureCode: code,
                holdClass: holdClass(attempt.failure),
              }),
            );
            if (held) {
              yield* scheduleRecovery(r, holdClass(attempt.failure));
              continue;
            }
          }
          const knownExpiry =
            code === "claim_busy"
              ? (yield* store.readResolutionSnapshot(r.space, work.memoryId!)).fence?.activeLease
                  ?.expiresAtHubTime
              : undefined;
          yield* store.retryClaimCandidate(
            work.id,
            now +
              (code === "claim_busy"
                ? 30000
                : Math.min(600000, [5000, 30000, 120000, 600000][Math.min(work.attempt, 3)]!)),
            code,
            knownExpiry === undefined ? undefined : Date.parse(knownExpiry),
          );
        }
      }
    }),
  );

  const pullTail = Effect.fnUntraced(function* (
    r: Route,
    budget: { pages: number; entries: number },
  ) {
    let highWatermark: number | undefined;
    while (budget.pages < 10 && budget.entries < 1000) {
      const after = yield* store.readCursor(r.space!, r.hubId);
      const page = yield* callPull(r, {
        protocolVersion: 1,
        memorySpaceId: r.space!,
        environmentId: local,
        afterSequence: after,
        limit: Math.min(100, 1000 - budget.entries),
        ...(highWatermark === undefined ? {} : { highWatermark }),
      }).pipe(
        Effect.flatMap(decodePull),
        Effect.mapError((e) =>
          e._tag === "SchemaError" ? new M.MemoryHubError({ code: "invalid_output" }) : e,
        ),
      );
      yield* ensureEpoch(r.settings.memoryHubVersion);
      if (
        page.checkpoint ||
        (highWatermark !== undefined && page.highWatermark !== highWatermark) ||
        page.throughSequence < after ||
        (page.hasMore && page.throughSequence === after)
      )
        return yield* new M.MemoryHubError({ code: "invalid_output" });
      highWatermark = page.highWatermark;
      yield* service.receiveHubPage({
        memorySpaceId: r.space!,
        hubEnvironmentId: r.hubId,
        localEnvironmentId: local,
        expectedSequence: after,
        page,
        reauthorize: ensureEpoch(r.settings.memoryHubVersion),
      });
      budget.pages++;
      budget.entries += page.entries.length;
      if (!page.hasMore) break;
    }
  });
  const bootstrap = Effect.fnUntraced(function* (
    r: Route,
    budget: { pages: number; entries: number },
  ) {
    if (!r.space) return yield* new M.MemoryHubError({ code: "bootstrap_required" });
    let state = yield* runtime.readBootstrap(r.space, r.hubId);
    if (state.state === "ready") {
      yield* rememberReadySpace(r);
      return true;
    }
    if (state.state === "unbound") {
      const input: M.MemoryHubJoinInput = {
        protocolVersion: 1,
        environmentId: local,
        memorySpaceId: r.space,
      };
      // The hub device is a replica too; use its active self authority without self HTTP.
      const join = yield* r.connection
        ? client.join(r.connection, input)
        : hub.join(input, r.principal!);
      yield* ensureEpoch(r.settings.memoryHubVersion);
      state = {
        state: "staging",
        checkpointId: `hub:${join.snapshotToken}`,
        snapshotToken: join.snapshotToken,
        checkpointSequence: join.checkpointSequence,
        cursor: null,
        pageCount: 0,
      };
      yield* store.transact(
        store.advanceBootstrapTx({
          memorySpaceId: r.space,
          hubEnvironmentId: r.hubId,
          expectedState: "unbound",
          nextState: "staging",
          checkpointId: state.checkpointId!,
          snapshotToken: state.snapshotToken,
          checkpointSequence: state.checkpointSequence,
          nextCursor: null,
        }),
      );
    }
    while (budget.pages < 10) {
      const response = yield* Effect.result(
        callPull(r, {
          protocolVersion: 1,
          memorySpaceId: r.space,
          environmentId: local,
          afterSequence: state.checkpointSequence,
          limit: 100,
          snapshotToken: state.snapshotToken!,
          ...(state.cursor ? { cursor: state.cursor } : {}),
        }),
      );
      if (response._tag === "Failure") {
        if (
          response.failure._tag === "MemoryHubError" &&
          response.failure.code === "cursor_expired"
        )
          yield* runtime.discardBootstrap(r.space, r.hubId, state.snapshotToken!);
        return yield* response.failure;
      }
      const page = (yield* decodePull(response.success).pipe(
        Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
      )).checkpoint;
      if (
        !page ||
        page.pageOrdinal !== state.pageCount ||
        page.checkpointSequence !== state.checkpointSequence
      )
        return yield* new M.MemoryHubError({ code: "invalid_output" });
      yield* ensureEpoch(r.settings.memoryHubVersion);
      const installed = yield* store
        .transact(
          Effect.gen(function* () {
            yield* ensureEpoch(r.settings.memoryHubVersion);
            const stage = {
              memorySpaceId: r.space!,
              hubEnvironmentId: r.hubId,
              checkpointId: state.checkpointId!,
              expectedSnapshotToken: state.snapshotToken!,
              expectedCheckpointSequence: state.checkpointSequence,
            };
            yield* store.installCheckpointPage({ ...stage, page });
            if (page.bootstrapComplete) {
              yield* store.completeCheckpoint({
                ...stage,
                localEnvironmentId: local,
                pageCount: state.pageCount + 1,
              });
              // The ready transition and browsing destination commit or roll back together.
              yield* writeLastReadySpace(r.space!);
            } else
              yield* store.advanceBootstrapTx({
                memorySpaceId: r.space!,
                hubEnvironmentId: r.hubId,
                expectedState: "staging",
                nextState: "staging",
                checkpointId: state.checkpointId!,
                snapshotToken: state.snapshotToken,
                checkpointSequence: state.checkpointSequence,
                nextCursor: page.nextCursor,
              });
          }),
          { finalGuard: ensureEpoch(r.settings.memoryHubVersion) },
        )
        .pipe(
          Effect.as(true),
          // Catch outside the outer Tx: a stale final page must roll back the whole install.
          Effect.catchTags({
            MemoryStoreConflict: (e) =>
              e.code === "revision_changed" ? Effect.succeed(false) : Effect.fail(e),
          }),
        );
      if (!installed) return false;
      budget.pages++;
      state = { ...state, pageCount: state.pageCount + 1, cursor: page.nextCursor };
      if (page.bootstrapComplete) return true;
    }
    return false;
  });
  const synchronizePull = Effect.fnUntraced(function* (
    r: Route,
    budget: { pages: number; entries: number },
  ) {
    const key = { memorySpaceId: r.space!, hubEnvironmentId: r.hubId };
    const retry = yield* store.readPullRetry(key);
    if (retry.nextAttemptAt > (yield* Clock.currentTimeMillis)) {
      yield* scheduleRecovery(r, retry.holdClass, false);
      return false;
    }
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const complete = yield* bootstrap(r, budget);
        if (complete && budget.pages < 10) yield* pullTail(r, budget);
        return complete;
      }),
    );
    yield* ensureEpoch(r.settings.memoryHubVersion);
    if (result._tag === "Failure") {
      const error = result.failure;
      const now = yield* Clock.currentTimeMillis;
      yield* store.transact(
        store.writePullRetryTx({
          ...key,
          expectedVersion: retry.version,
          retry: {
            attempts: Math.min(2147483647, retry.attempts + 1),
            nextAttemptAt: transient(error)
              ? now + Math.min(30000, 1000 * 2 ** Math.min(retry.attempts, 5))
              : Number.MAX_SAFE_INTEGER,
            failureCode: failureCode(error),
            holdClass: transient(error) ? null : holdClass(error),
          },
        }),
      );
      yield* scheduleRecovery(r, transient(error) ? null : holdClass(error));
      yield* wakePullRetry;
      return yield* error;
    }
    if (retry.attempts !== 0 || retry.failureCode !== null) {
      yield* store.transact(
        store.writePullRetryTx({
          ...key,
          expectedVersion: retry.version,
          retry: { attempts: 0, nextAttemptAt: 0, failureCode: null, holdClass: null },
        }),
      );
    }
    return result.success;
  });
  // Independent of summary pull progress; network and settings commits run outside SQL.
  const propagateSourceRevokes = (r: Route) =>
    Effect.gen(function* () {
      // Pending removals are durable in L5 settings. Retry before accepting new reads.
      if (runtime.ownerPolicy) {
        const committed = yield* runtime.ownerPolicy.read;
        for (const removal of committed.policy.removals) {
          if (
            removal.state !== "pending" ||
            removal.memorySpaceId !== r.space ||
            removal.ownerEnvironmentId !== local
          )
            continue;
          const revoke: M.MemoryHubSourceReadRevokeInput = {
            protocolVersion: 1,
            kind: "revoke",
            memorySpaceId: removal.memorySpaceId,
            requesterEnvironmentId: removal.requesterEnvironmentId,
            ownerPolicyEpoch: removal.removalEpoch,
          };
          const policy = runtime.ownerPolicy;
          yield* Effect.gen(function* () {
            yield* ensureEpoch(r.settings.memoryHubVersion);
            const result = yield* r.connection
              ? client.respondSourceRead(r.connection, revoke)
              : hub.respondSourceRead(revoke, r.principal!);
            yield* ensureEpoch(r.settings.memoryHubVersion);
            if (
              result.kind !== "revoke" ||
              !M.matchesMemorySourceReadRevokeAck(removal, result.ack)
            )
              return yield* new M.MemoryHubError({ code: "invalid_output" });
            yield* policy.recordRevokeAck(result.ack);
          }).pipe(Effect.catch((e) => noteFailure(r.settings.memoryHubVersion, e)));
        }
      }
    });
  const relayMutex = yield* Semaphore.make(1);
  let lastRelayRequest: M.MemorySourceReadRequestId | null = null;
  // Rotate the bounded collected page after the last attempted request. Read time leaves
  // room for the failure response; a stalled response cannot monopolize the next cycle.
  const relay = (r: Route) =>
    relayMutex
      .withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* store.transact(
            store.purgeHubTransientTx({ memorySpaceId: r.space!, now, limit: 100 }),
          );
          const input: M.MemoryHubSourceReadCollectInput = {
            protocolVersion: 1,
            memorySpaceId: r.space!,
            limit: 32,
          };
          const collected = yield* r.connection
            ? client.collectSourceReads(r.connection, input)
            : hub.collectSourceReads(input, r.principal!);
          const previous = collected.requests.findIndex((q) => q.requestId === lastRelayRequest);
          const requests = [
            ...collected.requests.slice(previous + 1),
            ...collected.requests.slice(0, previous + 1),
          ];
          for (const request of requests) {
            lastRelayRequest = request.requestId;
            yield* Effect.gen(function* () {
              if (
                request.sourceThread.environmentId !== local ||
                Date.parse(request.expiresAtHubTime) <= (yield* Clock.currentTimeMillis)
              )
                return;
              const policy = runtime.ownerPolicy ? yield* runtime.ownerPolicy.read : undefined;
              const permit = runtime
                .ownerPermit(request)
                .pipe(
                  Effect.andThen(ensureEpoch(r.settings.memoryHubVersion)),
                  Effect.andThen(
                    policy && runtime.ownerPolicy
                      ? runtime.ownerPolicy.read.pipe(
                          Effect.flatMap((current) =>
                            current.version === policy.version &&
                            current.policy.ownerPolicyEpoch === policy.policy.ownerPolicyEpoch
                              ? Effect.void
                              : Effect.fail(
                                  new Service.MemoryAccessError({ code: "route_unavailable" }),
                                ),
                          ),
                        )
                      : Effect.void,
                  ),
                );
              let validateSource: Effect.Effect<void, Service.MemoryServiceError> = Effect.fail(
                new Service.MemoryAccessError({ code: "route_unavailable" }),
              );
              const outcome = yield* Effect.gen(function* () {
                const read = yield* permit.pipe(
                  Effect.andThen(
                    runtime.ownerReader.readForRelay
                      ? runtime.ownerReader.readForRelay(request, permit).pipe(
                          Effect.map((read) => {
                            validateSource = read.validate;
                            return read.outcome;
                          }),
                        )
                      : runtime.ownerReader.readCommitted(request, permit),
                  ),
                  Effect.timeout("5 seconds"),
                  Effect.catchTags({
                    TimeoutError: () =>
                      Effect.succeed({ kind: "unavailable", code: "source_unavailable" } as const),
                  }),
                );
                yield* permit.pipe(Effect.timeout("1 second"));
                return read;
              }).pipe(
                Effect.catchTags({
                  MemoryAccessError: (error) =>
                    noteFailure(r.settings.memoryHubVersion, error).pipe(
                      Effect.as({
                        kind: "denied",
                        requiredPermission: "orchestration:read",
                      } as const),
                    ),
                  MemoryStoreConflict: (error) =>
                    Effect.succeed({
                      kind: "unavailable" as const,
                      code:
                        error.code === "forgotten"
                          ? ("forgotten" as const)
                          : ("source_invalidated" as const),
                    }),
                }),
              );
              // Denial needs no source grant, but every response still belongs to this epoch.
              yield* ensureEpoch(r.settings.memoryHubVersion);
              if (Date.parse(request.expiresAtHubTime) <= (yield* Clock.currentTimeMillis)) return;
              const checked = yield* decodeSource(outcome).pipe(
                Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
              );
              if (
                checked.kind === "available" &&
                (checked.page.sourceThread.environmentId !== request.sourceThread.environmentId ||
                  checked.page.sourceThread.threadId !== request.sourceThread.threadId ||
                  checked.page.watermark.fromEventId !== request.sourceWatermark.fromEventId ||
                  checked.page.watermark.toEventId !== request.sourceWatermark.toEventId ||
                  checked.page.watermark.throughSequence !==
                    request.sourceWatermark.throughSequence ||
                  checked.page.messages.length > request.limit ||
                  checked.page.messages.some(
                    (message) => !request.messageIds.includes(message.messageId),
                  ))
              )
                return yield* new M.MemoryHubError({ code: "source_invalidated" });
              const safe: M.MemorySourceReadOutcome =
                scanMemoryValue(checked).kind === "allowed"
                  ? checked
                  : { kind: "unavailable", code: "secret_detected" };
              const response: M.MemoryHubSourceReadRespondInput = {
                kind: "normal",
                ownerPolicyEpoch: policy?.policy.ownerPolicyEpoch ?? 0,
                protocolVersion: 1,
                memorySpaceId: r.space!,
                requestId: request.requestId,
                outcome: safe,
              };
              yield* ensureEpoch(r.settings.memoryHubVersion);
              const prepareResponse = Effect.gen(function* () {
                if (response.outcome.kind !== "available") return response;
                const validation = yield* Effect.result(
                  permit.pipe(Effect.andThen(validateSource)),
                );
                return validation._tag === "Success"
                  ? response
                  : {
                      ...response,
                      outcome: {
                        kind: "unavailable" as const,
                        code: "source_invalidated" as const,
                      },
                    };
              });
              yield* (
                r.connection
                  ? client.respondSourceRead(r.connection, response, prepareResponse)
                  : prepareResponse.pipe(
                      Effect.flatMap((input) => hub.respondSourceRead(input, r.principal!)),
                    )
              ).pipe(Effect.timeout("1 second"));
            }).pipe(
              Effect.catchTags({
                TimeoutError: () =>
                  Effect.fail(new M.MemoryHubError({ code: "source_unavailable" })),
              }),
              Effect.catch((e) => noteFailure(r.settings.memoryHubVersion, e)),
            );
          }
        }),
      )
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.catchTags({
          TimeoutError: () => Effect.void,
        }),
      );
  const push = Effect.fnUntraced(function* (r: Route) {
    const now = yield* Clock.currentTimeMillis;
    const candidates = yield* store.readEligibleOutbox(r.space!, now, 100);
    let bytes = 0;
    for (const candidate of candidates) {
      const operation = yield* store.readWorkOperation(candidate.work.id);
      if (!operation) continue;
      const input: M.MemoryHubPushInput = {
        protocolVersion: 1,
        memorySpaceId: r.space!,
        environmentId: local,
        operations: [operation],
      };
      const encoded = yield* encodePush(input).pipe(
        Effect.mapError(() => new M.MemoryHubError({ code: "payload_too_large" })),
      );
      const length = new TextEncoder().encode(encoded).length;
      if (bytes + length > 1048576) break;
      bytes += length;
      const acquired = yield* store.transact(
        store.acquireSyncWorkTx({
          workId: candidate.work.id,
          operationId: candidate.operationId,
          operationDigest: candidate.operationDigest,
          owner,
          expectedVersion: candidate.version,
          now,
          ownedUntil: now + 30000,
        }),
      );
      if (!acquired) continue;
      const result = yield* Effect.result(
        Effect.gen(function* () {
          yield* ensureEpoch(r.settings.memoryHubVersion);
          const ack = yield* r.connection
            ? client.push(r.connection, input)
            : hub.push(input, r.principal!);
          yield* ensureEpoch(r.settings.memoryHubVersion);
          const receipt = ack.receipts[0];
          if (
            ack.receipts.length !== 1 ||
            !receipt ||
            receipt.operationId !== acquired.operationId ||
            receipt.operationDigest !== acquired.operationDigest
          )
            return yield* new M.MemoryHubError({ code: "invalid_output" });
          yield* service.settleHubAcknowledgement({
            memorySpaceId: r.space!,
            hubEnvironmentId: r.hubId,
            localEnvironmentId: local,
            workId: acquired.workId,
            receipt,
            operation: acquired,
            reauthorize: ensureEpoch(r.settings.memoryHubVersion),
          });
        }),
      );
      if (result._tag === "Failure") {
        yield* ensureEpoch(r.settings.memoryHubVersion);
        yield* noteFailure(r.settings.memoryHubVersion, result.failure);
        const time = yield* Clock.currentTimeMillis;
        yield* store.transact(
          store.retrySyncWorkTx({
            ownership: acquired,
            now: time,
            nextAttemptAt: transient(result.failure)
              ? time + Math.min(30000, 1000 * 2 ** Math.min(candidate.work.attempt, 5))
              : Number.MAX_SAFE_INTEGER,
            failureCode: failureCode(result.failure),
            ...(transient(result.failure) ? {} : { holdClass: holdClass(result.failure) }),
          }),
        );
        yield* scheduleRecovery(r, transient(result.failure) ? null : holdClass(result.failure));
      }
    }
  });
  const readPublication =
    committedSettings.readPublication ??
    Effect.succeed<M.MemoryHubPublication>({ state: "unknown" });
  const requireCurrentPublication = readPublication.pipe(
    Effect.flatMap((p) =>
      p.state === "current"
        ? Effect.void
        : Effect.fail(new Service.MemoryAccessError({ code: "fenced" })),
    ),
  );
  const rearmPage = Effect.fnUntraced(function* (r: Route) {
    for (const [c, pending] of rearms) {
      if (pending.epoch !== r.settings.memoryHubVersion || pending.space !== r.space) {
        rearms.delete(c);
        continue;
      }
      const permit = pending.permit;
      yield* ensureEpoch(pending.epoch);
      const now = yield* Clock.currentTimeMillis;
      const page = yield* store
        .transact(
          Effect.gen(function* () {
            yield* ensureEpoch(pending.epoch);
            if (permit) {
              yield* permit;
              yield* requireCurrentPublication;
              if ((yield* runtime.readBootstrap(pending.space, r.hubId)).state !== "ready")
                return yield* new M.MemoryHubError({ code: "bootstrap_required" });
            }
            const input = { memorySpaceId: pending.space, holdClass: c, now, limit: 100 };
            const empty: Store.HoldRearmPage = {
              changedIds: [],
              inspected: 0,
              next: null,
              more: false,
            };
            const sync = pending.syncDone
              ? empty
              : yield* store.rearmSyncHoldsTx({ ...input, afterId: pending.syncAfter });
            const resolution = pending.resolutionDone
              ? empty
              : yield* store.rearmResolutionHoldsTx({ ...input, afterId: pending.resolutionAfter });
            const key = { memorySpaceId: pending.space, hubEnvironmentId: r.hubId };
            const retry = yield* store.readPullRetry(key);
            if (retry.holdClass === c)
              yield* store.writePullRetryTx({
                ...key,
                expectedVersion: retry.version,
                retry: { attempts: 0, nextAttemptAt: now, failureCode: null, holdClass: null },
              });
            if (permit) {
              yield* permit;
              yield* ensureEpoch(pending.epoch);
              yield* requireCurrentPublication;
            }
            return { sync, resolution };
          }),
          {
            requireOuter: true,
            finalGuard: ensureEpoch(pending.epoch).pipe(
              Effect.andThen(permit ?? Effect.void),
              Effect.andThen(permit ? requireCurrentPublication : Effect.void),
            ),
          },
        )
        .pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              // Retire only this request's pending work, including background pages.
              // Any coalesced automatic observation is replaced by a fresh probe;
              // remaining manual work never inherits automatic authority.
              if (permit && rearms.get(c) === pending && pending.permit === permit) {
                rearms.delete(c);
                yield* scheduleRecovery(r, c, false);
              }
            }),
          ),
        );
      if (pending.restartRequested) {
        pending.restartRequested = false;
        pending.syncDone = false;
        pending.resolutionDone = false;
        pending.syncAfter = "";
        pending.resolutionAfter = "";
        continue;
      }
      yield* wakePullRetry;
      pending.syncDone ||= !page.sync.more;
      pending.resolutionDone ||= !page.resolution.more;
      pending.syncAfter = page.sync.next ?? pending.syncAfter;
      pending.resolutionAfter = page.resolution.next ?? pending.resolutionAfter;
      if (pending.syncDone && pending.resolutionDone) {
        // This cursor sweep owns no recovery generation. A later failure may already
        // have registered the next probe while an earlier page was being retried.
        rearms.delete(c);
      }
    }
    if (rearms.size) pendingSync = true;
  });
  const syncCycle = mutex.withPermit(
    Effect.gen(function* () {
      if (stopped) return;
      const s = yield* readSettings;
      resetStatus(s.memoryHubVersion);
      const r = yield* route();
      if (!r) {
        for (const entry of executions.values())
          if (entry.fiber) yield* Fiber.interrupt(entry.fiber);
        return;
      }
      for (const entry of executions.values())
        if (entry.epoch !== r.settings.memoryHubVersion && entry.fiber)
          yield* Fiber.interrupt(entry.fiber);
      lastFailure = undefined;
      yield* propagateSourceRevokes(r);
      yield* discoverRecoveries(r);
      if (discoveryEpoch === r.settings.memoryHubVersion && discoveryFailure)
        yield* noteFailure(r.settings.memoryHubVersion, discoveryFailure);
      yield* rearmPage(r);
      const budget = { pages: 0, entries: 0 };
      if (!(yield* synchronizePull(r, budget)) || budget.pages >= 10) return;
      for (const entry of executions.values()) {
        if (entry.fiber && (yield* Effect.result(eligibility(entry.ticket)))._tag === "Failure")
          yield* Fiber.interrupt(entry.fiber);
      }
      yield* relay(r).pipe(Effect.catch((e) => noteFailure(r.settings.memoryHubVersion, e)));
      yield* ensureEpoch(r.settings.memoryHubVersion);
      // Tail checkpoint S is incorporated before any local identity assignment or push.
      for (const intent of yield* store.listMaterializableIntents(local, 100)) {
        yield* ensureEpoch(r.settings.memoryHubVersion);
        yield* service.commitLocalIntent({
          assignment: {
            intentId: intent.intentId,
            memorySpaceId: r.space!,
            operationId: M.MemoryOperationId.make(uuid()),
            revisionId: M.MemoryRevisionId.make(uuid()),
          },
          expectedEpoch: r.settings.memoryHubVersion,
          readBinding: runtime.readIntentBinding
            ? runtime.readIntentBinding.pipe(
                Effect.map((binding) => ({ ...binding, enabled: binding.enabled && !stopped })),
              )
            : Effect.fail(new Service.MemoryAccessError({ code: "fenced" })),
        });
      }
      yield* push(r);
      yield* synchronizePull(r, budget);
      yield* sweep;
      yield* ensureEpoch(r.settings.memoryHubVersion);
      lastSuccess = { epoch: r.settings.memoryHubVersion, at: iso(yield* Clock.currentTimeMillis) };
    }),
  );
  // A single tracked cycle includes manual sync and registry sweeps. Waiters coalesce;
  // A pending full sync outranks a completion sweep; both are single coalesced hints.
  const requestCycle = (effect: Effect.Effect<void, Error>, sweepOnly = false, wait = true) =>
    Effect.gen(function* () {
      const active = yield* coordinator.withPermit(
        Effect.gen(function* () {
          if (stopped || cancelling) return null;
          if (cycle) {
            if (sweepOnly) pendingSweep = true;
            else pendingSync = true;
            return cycle;
          }
          const epoch = (yield* committedSettings.read).version;
          resetStatus(epoch);
          // Disabled/empty cycles can finish before fork returns. Publish the tracked
          // fiber before releasing its start gate so its finalizer cannot be overwritten.
          const ready = yield* Deferred.make<void>();
          const fiber = yield* Effect.gen(function* () {
            yield* Deferred.await(ready);
            yield* effect;
            while (pendingSync || pendingSweep) {
              if (stopped || cancelling) break;
              yield* ensureEpoch(epoch);
              if (pendingSync) {
                pendingSync = false;
                pendingSweep = false;
                yield* syncCycle;
              } else {
                pendingSweep = false;
                yield* sweep;
              }
            }
          }).pipe(
            Effect.tapError((e) => noteFailure(epoch, e)),
            Effect.ensuring(
              Effect.sync(() => {
                cycle = null;
              }),
            ),
            Effect.forkIn(scope),
          );
          cycle = fiber;
          yield* Deferred.succeed(ready, undefined);
          return fiber;
        }).pipe(Effect.uninterruptible),
      );
      if (!active || !wait) return;
      const exit = yield* Fiber.await(active);
      if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause))
        return yield* Effect.failCause(exit.cause);
    });
  const syncOnce = requestCycle(syncCycle);
  const guardedSync = syncOnce.pipe(Effect.ignore);
  // Timers only schedule real reads. A successful pinned descriptor is the observation;
  // authorization is deliberately never inferred from this public, credential-free read.
  const recoveryLoop: Effect.Effect<void> = Effect.gen(function* () {
    while (!stopped && recoveries.size) {
      const next = Math.min(...[...recoveries.values()].map((p) => p.due));
      const signal = recoveryChanged;
      const elapsed = yield* Effect.raceFirst(
        Effect.sleep(Math.max(0, next - (yield* Clock.currentTimeMillis))).pipe(Effect.as(true)),
        Deferred.await(signal).pipe(Effect.as(false)),
      );
      if (!elapsed) {
        if (signal === recoveryChanged) recoveryChanged = yield* Deferred.make<void>();
        continue;
      }
      for (const [c, pending] of recoveries) {
        if (pending.due > (yield* Clock.currentTimeMillis)) continue;
        const r = pending.route;
        const observed = yield* Effect.result(
          Effect.gen(function* () {
            yield* ensureEpoch(r.settings.memoryHubVersion);
            const descriptor = yield* client.preflight(r.connection!);
            if (descriptor.environmentId !== r.hubId)
              return yield* new M.MemoryHubError({ code: "identity_mismatch" });
            if (descriptor.capabilities.memoryHubProtocolVersion !== 1)
              return yield* new M.MemoryHubError({ code: "unsupported_protocol" });
            yield* ensureEpoch(r.settings.memoryHubVersion);
          }).pipe(Effect.timeout("15 seconds")),
        );
        if (recoveries.get(c)?.generation !== pending.generation) continue;
        if (observed._tag === "Success") {
          recoveries.delete(c);
          enqueueRearm(r.settings.memoryHubVersion, r.space!, [c]);
          yield* requestCycle(syncCycle, false, false).pipe(Effect.ignore);
        } else {
          pending.delay = Math.min(900000, pending.delay * 2);
          pending.due = (yield* Clock.currentTimeMillis) + pending.delay;
        }
      }
    }
  }).pipe(Effect.ignore);
  const cancelEpoch = coordinator.withPermit(
    Effect.gen(function* () {
      cancelling = true;
      pendingSweep = false;
      pendingSync = false;
      const unfinished = [...rearms]
        .filter(
          ([, pending]) =>
            pending.epoch === previousBinding.epoch &&
            pending.space === previousBinding.space &&
            // A Settings request cannot become an unguarded observation in a new epoch.
            pending.permit === undefined &&
            !(pending.syncDone && pending.resolutionDone),
        )
        .map(([c]) => c);
      rearms.clear();
      recoveries.clear();
      const probe = recoveryFiber;
      const active = cycle;
      // No sync/registry mutex is held while cancellation is requested. Cycle interruption
      // finishes any registration reservation first; matching release has a 15s bound.
      yield* Fiber.interruptAll([
        ...(probe ? [probe] : []),
        ...(active ? [active] : []),
        ...[...executions.values()].flatMap((e) => (e.fiber ? [e.fiber] : [])),
      ]);
      cycle = null;
      const s = yield* committedSettings.read;
      settingsEpoch = s.version;
      resetStatus(s.version);
      // Cancellation fences old transports, but an accepted observation still belongs to
      // the same space/hub. Restart its bounded cursors under the committed epoch.
      if (
        !stopped &&
        s.settings.mode !== "disabled" &&
        s.settings.memorySpaceId !== null &&
        s.settings.mode === previousBinding.mode &&
        s.settings.memorySpaceId === previousBinding.space &&
        (s.settings.mode === "member" ? s.settings.hubEnvironmentId : local) === previousBinding.hub
      )
        enqueueRearm(s.version, s.settings.memorySpaceId, unfinished);
      cancelling = false;
    }),
  );
  const shutdown = Effect.gen(function* () {
    stopped = true;
    yield* cancelEpoch;
    yield* Fiber.interruptAll(background);
  });
  yield* Effect.addFinalizer(() => shutdown);
  const start = Effect.gen(function* () {
    if (started || stopped) return;
    started = true;
    const wakes = yield* store.subscribeWake.pipe(Effect.provideService(Scope.Scope, scope));
    const changes = yield* settings.subscribeChanges.pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    background.push(yield* Stream.runForEach(wakes, () => guardedSync).pipe(Effect.forkIn(scope)));
    background.push(
      yield* Stream.runForEach(changes, (s) =>
        Effect.gen(function* () {
          if (s.memoryHubVersion !== settingsEpoch) yield* cancelEpoch;
          const next = bindingKey(s);
          const classes: Store.MemoryHoldClass[] = [];
          if (
            next.epoch !== previousBinding.epoch ||
            next.credential !== previousBinding.credential
          )
            classes.push("authorization");
          if (
            next.mode !== previousBinding.mode ||
            next.hub !== previousBinding.hub ||
            next.space !== previousBinding.space
          )
            classes.push("identity");
          if (next.endpoint !== previousBinding.endpoint) classes.push("protocol", "availability");
          if (next.model !== previousBinding.model) classes.push("availability");
          previousBinding = next;
          if (next.space) enqueueRearm(next.epoch, next.space, classes);
          // Do not block the settings consumer on the next transport.
          yield* requestCycle(syncCycle, false, false).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkIn(scope)),
    );
    if (runtime.ownerPolicy) {
      const changes = yield* runtime.ownerPolicy.changes.pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      background.push(
        yield* Stream.runForEach(changes, () => guardedSync).pipe(Effect.forkIn(scope)),
      );
    }
    if (runtime.rearmEvents)
      background.push(
        yield* Stream.runForEach(runtime.rearmEvents, (event) =>
          Effect.gen(function* () {
            const view = yield* committedSettings.read;
            const space = view.settings.mode === "disabled" ? null : view.settings.memorySpaceId;
            const hubId = view.settings.mode === "member" ? view.settings.hubEnvironmentId : local;
            if (
              !space ||
              space !== event.memorySpaceId ||
              stopped ||
              view.version !== event.epoch ||
              hubId !== event.hubEnvironmentId
            )
              return;
            // Keep the observed epoch through the existing in-transaction authority check.
            enqueueRearm(event.epoch, space, [event.holdClass]);
            yield* requestCycle(syncCycle, false, false);
          }),
        ).pipe(Effect.ignore, Effect.forkIn(scope)),
      );
    background.push(
      yield* Effect.gen(function* () {
        while (!stopped) {
          const signal = pullRetryChanged;
          const r = yield* route().pipe(Effect.orElseSucceed(() => null));
          const now = yield* Clock.currentTimeMillis;
          const retry = r?.space
            ? yield* store
                .readPullRetry({
                  memorySpaceId: r.space,
                  hubEnvironmentId: r.hubId,
                })
                .pipe(Effect.orElseSucceed(() => null))
            : null;
          const delay =
            retry && retry.nextAttemptAt > now && retry.nextAttemptAt !== Number.MAX_SAFE_INTEGER
              ? Math.min(30000, retry.nextAttemptAt - now)
              : 30000;
          const elapsed = yield* Effect.raceFirst(
            Effect.sleep(delay).pipe(Effect.as(true)),
            Deferred.await(signal).pipe(Effect.as(false)),
          );
          if (elapsed) yield* guardedSync;
          else if (signal === pullRetryChanged) pullRetryChanged = yield* Deferred.make<void>();
        }
      }).pipe(Effect.forkIn(scope)),
    );
    yield* guardedSync;
  });
  const readLocalReadiness = Effect.fnUntraced(function* () {
    const r = yield* route();
    if (!r?.space) return { memorySpaceId: null, bootstrap: "unbound" as const };
    return {
      memorySpaceId: r.space,
      bootstrap: (yield* runtime.readBootstrap(r.space, r.hubId)).state,
    };
  });
  // A Settings request owns its permit through every bounded rearm page. A public
  // descriptor proves protocol/availability recovery only, never identity or credentials.
  const reconcileHub: MemorySyncService["Service"]["reconcileHub"] = (input, permit) =>
    mutex
      .withPermit(
        Effect.gen(function* () {
          yield* permit;
          if (input.environmentId !== local)
            return yield* new M.MemoryHubError({ code: "identity_mismatch" });
          yield* ensureEpoch(input.expectedVersion);
          yield* requireCurrentPublication;
          const r = yield* route();
          if (!r?.space) return yield* new M.MemoryHubError({ code: "bootstrap_required" });
          if (
            r.space !== input.memorySpaceId ||
            r.settings.memoryHubVersion !== input.expectedVersion
          )
            return yield* new M.MemoryHubError({ code: "fenced" });
          if ((yield* runtime.readBootstrap(r.space, r.hubId)).state !== "ready")
            return yield* new M.MemoryHubError({ code: "bootstrap_required" });
          const classes = yield* store.readPersistedHoldClasses({
            memorySpaceId: r.space,
            hubEnvironmentId: r.hubId,
          });
          // Reauthorize after the SQL wait, even on a refusal/no-op path.
          yield* permit;
          yield* ensureEpoch(input.expectedVersion);
          yield* requireCurrentPublication;
          if (classes.includes("authorization"))
            return yield* new M.MemoryHubError({ code: "route_unavailable" });
          if (classes.includes("identity"))
            return yield* new M.MemoryHubError({ code: "identity_mismatch" });
          const recoverable = classes.filter(
            (c): c is "protocol" | "availability" => c === "protocol" || c === "availability",
          );
          if (!recoverable.length) return { version: input.expectedVersion, rearmedClasses: [] };
          if (!r.connection) return yield* new M.MemoryHubError({ code: "route_unavailable" });
          const descriptor = yield* client.preflight(r.connection);
          if (descriptor.environmentId !== r.hubId)
            return yield* new M.MemoryHubError({ code: "identity_mismatch" });
          if (descriptor.capabilities.memoryHubProtocolVersion !== 1)
            return yield* new M.MemoryHubError({ code: "unsupported_protocol" });
          yield* permit;
          yield* ensureEpoch(input.expectedVersion);
          yield* requireCurrentPublication;
          enqueueRearm(input.expectedVersion, r.space, recoverable, permit);
          yield* rearmPage(r);
          return { version: input.expectedVersion, rearmedClasses: recoverable };
        }),
      )
      .pipe(
        Effect.tap((result) =>
          result.rearmedClasses.length && started
            ? requestCycle(syncCycle, false, false)
            : Effect.void,
        ),
      );
  return MemorySyncService.of({
    start,
    syncOnce,
    reconcileHub,
    shutdown,
    scheduleConflictResolution: requestCycle(sweep, true),
    activeResolutions: Effect.sync(() => executions.size + reservations),
    readLocalReadiness,
    requireBootstrap: (space) =>
      readLocalReadiness().pipe(
        Effect.flatMap((r) =>
          r.memorySpaceId === space && r.bootstrap === "ready"
            ? Effect.void
            : Effect.fail(new M.MemoryHubError({ code: "bootstrap_required" })),
        ),
      ),
    initializeDefaultHub: Effect.gen(function* () {
      const admin = yield* Effect.serviceOption(Hub.MemoryHubAdministrator);
      if (Option.isNone(admin)) return yield* new M.MemoryHubError({ code: "route_unavailable" });
      yield* admin.value.initializeDefaultHub;
      yield* guardedSync;
    }),
    getHubSettings: (_input, permit) =>
      permit.pipe(
        Effect.andThen(readSettings),
        Effect.flatMap((s) =>
          Hub.readSettingsView(store, {
            settings: s.memoryHub,
            version: s.memoryHubVersion,
          }),
        ),
      ),
    updateHubSettings: (input, permit) =>
      Effect.gen(function* () {
        yield* permit;
        const admin = yield* Effect.serviceOption(Hub.MemoryHubAdministrator);
        if (Option.isNone(admin)) return yield* new M.MemoryHubError({ code: "route_unavailable" });
        const result = yield* admin.value.update(
          input,
          permit.pipe(Effect.mapError(() => new M.MemoryHubForbiddenError({}))),
        );
        yield* guardedSync;
        return result;
      }),
    hubDiagnostics: (_input, permit) =>
      Effect.gen(function* () {
        yield* permit;
        const s = yield* readSettings;
        const epoch = s.memoryHubVersion;
        resetStatus(epoch);
        const space = s.memoryHub.mode === "disabled" ? null : s.memoryHub.memorySpaceId;
        const hubId = s.memoryHub.mode === "member" ? s.memoryHub.hubEnvironmentId : local;
        const bootstrap = space ? (yield* runtime.readBootstrap(space, hubId)).state : "unbound";
        const holds = space
          ? yield* store.readPersistedHoldClasses({ memorySpaceId: space, hubEnvironmentId: hubId })
          : [];
        yield* permit;
        const current = yield* readSettings;
        if (current.memoryHubVersion !== epoch)
          return yield* new M.MemoryHubError({ code: "fenced" });
        const failure = lastFailure?.epoch === epoch ? lastFailure.code : undefined;
        const success = lastSuccess?.epoch === epoch ? lastSuccess.at : null;
        const publication = yield* readPublication;
        const recoverableHolds = holds.filter(
          (c): c is "protocol" | "availability" => c === "protocol" || c === "availability",
        );
        const permanentHolds = holds.filter(
          (c): c is "identity" | "authorization" => c === "identity" || c === "authorization",
        );
        const disabled = s.memoryHub.mode === "disabled";
        return {
          version: epoch,
          publication,
          readiness: disabled ? "disabled" : bootstrap,
          connection: disabled
            ? "disabled"
            : failure === "unavailable"
              ? "unreachable"
              : failure
                ? "unknown"
                : success
                  ? "connected"
                  : "unknown",
          recoverableHolds,
          permanentHolds,
          reconcile:
            disabled || bootstrap !== "ready" || publication.state !== "current"
              ? "unavailable"
              : permanentHolds.length
                ? "permanent_hold"
                : recoverableHolds.length
                  ? "available"
                  : "not_needed",
        };
      }),
    syncStatus: (input, permit) =>
      Effect.gen(function* () {
        yield* permit;
        const s = yield* readSettings;
        const epoch = s.memoryHubVersion;
        resetStatus(epoch);
        const space = s.memoryHub.mode === "disabled" ? null : s.memoryHub.memorySpaceId;
        const includeRetained =
          "includeRetainedLocalSpaceId" in input && input.includeRetainedLocalSpaceId;
        const retainedLocalSpaceId = includeRetained ? yield* readRetainedSpace : null;
        const hubId = s.memoryHub.mode === "member" ? s.memoryHub.hubEnvironmentId : local;
        const bootstrap = space ? (yield* runtime.readBootstrap(space, hubId)).state : "unbound";
        if (bootstrap === "ready") yield* rememberReadySpace({ space, settings: s });
        const persisted = yield* runtime.readProcessing(space, space ? hubId : null);
        const storage = space
          ? yield* quota.readStorageStatus({ memorySpaceId: space, environmentId: local })
          : yield* runtime.readUnboundStorage;
        yield* permit;
        const current = yield* readSettings;
        if (current.memoryHubVersion !== epoch)
          return yield* new M.MemoryHubError({ code: "fenced" });
        const failure = lastFailure?.epoch === epoch ? lastFailure.code : undefined;
        const success = lastSuccess?.epoch === epoch ? lastSuccess.at : null;
        const selected = memorySelection(current);
        const memoryModel =
          selected === null
            ? Option.none<M.MemoryModelSelection>()
            : yield* decodeMemorySelection(selected).pipe(Effect.option);
        const generationHold =
          "includeGenerationHold" in input &&
          input.includeGenerationHold &&
          Option.isSome(memoryModel)
            ? yield* hold.status(yield* hold.keyFor(memoryModel.value))
            : undefined;
        return {
          memorySpaceId: space,
          ...(includeRetained
            ? { retainedLocalSpaceId: bootstrap === "ready" ? space : retainedLocalSpaceId }
            : {}),
          state:
            s.memoryHub.mode === "disabled"
              ? "disabled"
              : bootstrap !== "ready"
                ? "bootstrapping"
                : failure
                  ? "offline"
                  : "online",
          pendingSync: persisted.pendingSync,
          quarantined: persisted.quarantined,
          parked: persisted.parked,
          lastSuccessfulSyncAtUtc: success,
          lastHubSequence: persisted.processing.lastReceivedHubSequence,
          storage,
          processing: persisted.processing,
          ...(failure ? { failureCode: failure } : {}),
          ...(generationHold ? { generationHold } : {}),
        };
      }),
    readSource: (validated, permit) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        return yield* Effect.gen(function* () {
          yield* permit;
          const r = yield* route();
          if (!r || r.space !== validated.request.memorySpaceId)
            return yield* new M.MemoryHubError({ code: "space_mismatch" });
          yield* service.validateSourceOutcome(
            { request: validated, outcome: { kind: "unavailable", code: "source_unavailable" } },
            permit,
          );
          yield* permit;
          const submission = {
            ...validated.request,
            requestId: M.MemorySourceReadRequestId.make(uuid()),
          };
          const requested = yield* r.connection
            ? client.requestSourceRead(r.connection, submission)
            : hub.requestSourceRead(submission, r.principal!);
          yield* permit;
          if (
            !requested.request.stamp ||
            requested.request.requestId !== submission.requestId ||
            requested.request.requesterEnvironmentId !== local ||
            requested.request.stamp.locatorDigest !==
              OwnerSource.sourceReadLocatorDigest(submission) ||
            Date.parse(requested.request.expiresAtHubTime) >
              (yield* Clock.currentTimeMillis) + 75000
          )
            return yield* new M.MemoryHubError({ code: "source_invalidated" });
          yield* ensureEpoch(r.settings.memoryHubVersion);
          const deadline = Math.min(
            startedAt + 75000,
            Date.parse(requested.request.expiresAtHubTime),
          );
          return yield* Effect.gen(function* () {
            while ((yield* Clock.currentTimeMillis) < deadline) {
              yield* permit;
              yield* ensureEpoch(r.settings.memoryHubVersion);
              yield* relay(r);
              const i = {
                protocolVersion: 1 as const,
                memorySpaceId: validated.request.memorySpaceId,
                requestId: submission.requestId,
              };
              const result = yield* r.connection
                ? client.resultSourceRead(r.connection, i)
                : hub.resultSourceRead(i, r.principal!);
              yield* permit;
              yield* ensureEpoch(r.settings.memoryHubVersion);
              if ((yield* Clock.currentTimeMillis) >= deadline) break;
              if (result.state === "completed")
                return yield* service.validateSourceOutcome(
                  { request: validated, outcome: result.outcome },
                  permit,
                );
              if (result.state === "expired") break;
              yield* Effect.sleep(Math.min(1000, deadline - (yield* Clock.currentTimeMillis)));
            }
            return { kind: "unavailable", code: "source_unavailable" } as const;
          }).pipe(Effect.timeout(Math.max(0, deadline - (yield* Clock.currentTimeMillis))));
        }).pipe(Effect.timeout(Math.max(0, startedAt + 75000 - (yield* Clock.currentTimeMillis))));
      }).pipe(
        Effect.catchTags({
          TimeoutError: () =>
            Effect.succeed({ kind: "unavailable", code: "source_unavailable" } as const),
        }),
        Effect.catchTags({
          MemoryHubUnauthorizedError: () =>
            Effect.fail(new Service.MemoryAccessError({ code: "route_unavailable" })),
          MemoryHubForbiddenError: () =>
            Effect.fail(new Service.MemoryAccessError({ code: "route_unavailable" })),
        }),
      ),
  });
});

export const layer = Layer.effect(MemorySyncService, make);
