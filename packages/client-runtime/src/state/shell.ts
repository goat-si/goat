import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@goat/contracts";
import { watchHubProxySnapshot } from "./hubProxySnapshot.ts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { connectionProjectionPhase, type PreparedConnection } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import { subscribeDynamicWithSession } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import type { DeferredShellSnapshot } from "./shellPullRequests.ts";
import {
  applyShellStreamEvents,
  type ShellStreamEvent,
  mergeShellSnapshotProjects,
  reuseUnchangedThreadShells,
  sameThreadPullRequests,
} from "./shellReducer.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export type EnvironmentShellStatus = "empty" | "cached" | "synchronizing" | "live";

export interface EnvironmentShellState {
  readonly snapshot: Option.Option<OrchestrationV2ShellSnapshot>;
  readonly status: EnvironmentShellStatus;
  readonly meta?: Persistence.ShellSnapshotMeta;
  readonly error: Option.Option<string>;
  /**
   * Changes with each authoritative snapshot (not enrichment refreshes); 0 until the first one.
   * Thread families read for an older generation may miss changes from before the latest snapshot,
   * so they are read again.
   */
  readonly generation: number;
  /** In-memory owner of the authoritative snapshot; never included in the persisted snapshot. */
  readonly authoritativeSession: RpcSession | null;
  /** Sequences of the thread removals applied since the latest authoritative snapshot. */
  readonly removedAt: ReadonlyMap<ThreadId, number>;
}

const EMPTY_REMOVALS: ReadonlyMap<ThreadId, number> = new Map();
// Shared by every shell state, so a rebuilt one never reuses a generation another already used.
let lastShellGeneration = 0;

export const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
  generation: 0,
  authoritativeSession: null,
  removedAt: EMPTY_REMOVALS,
};

function shellStatusForSnapshot(
  snapshot: Option.Option<OrchestrationV2ShellSnapshot>,
): EnvironmentShellStatus {
  return Option.isSome(snapshot) ? "cached" : "empty";
}

function withoutDeferredPullRequests(value: DeferredShellSnapshot): OrchestrationV2ShellSnapshot {
  if (value.loadPullRequests === undefined) return value;
  const { loadPullRequests: _deferred, ...snapshot } = value;
  return snapshot;
}

const SHELL_SYNCHRONIZATION_ERROR_MESSAGE = "Could not synchronize environment data.";

const CACHE_RESUME_MAX_AGE_MILLIS = 12 * 60 * 60 * 1000;
type ShellOriginIdentity = Omit<Persistence.ShellCacheOrigin, "snapshotAt">;

function sameShellIdentity(left: ShellOriginIdentity, right: ShellOriginIdentity | null): boolean {
  return (
    right !== null &&
    left.instanceId === right.instanceId &&
    left.serverVersion === right.serverVersion &&
    left.databaseMigration === right.databaseMigration &&
    left.omitIdleSubagents === right.omitIdleSubagents &&
    left.omitOlderSettled === right.omitOlderSettled
  );
}

function canResumeFrom(
  origin: Persistence.ShellCacheOrigin | undefined,
  identity: ShellOriginIdentity | null,
  now: number,
): boolean {
  if (origin === undefined) return false;
  const age = now - origin.snapshotAt;
  return age >= 0 && age < CACHE_RESUME_MAX_AGE_MILLIS && sameShellIdentity(origin, identity);
}

function shellIdentity(
  descriptor: ExecutionEnvironmentDescriptor | undefined,
  flags: { readonly shellThreadFamilies?: boolean; readonly shellOlderSettled?: boolean },
): ShellOriginIdentity | null {
  if (!descriptor?.instanceId || !descriptor.serverVersion) return null;
  const omitIdleSubagents = flags.shellThreadFamilies === true;
  return {
    instanceId: descriptor.instanceId,
    serverVersion: descriptor.serverVersion,
    databaseMigration: descriptor.databaseMigration ?? null,
    omitIdleSubagents,
    omitOlderSettled: omitIdleSubagents && flags.shellOlderSettled === true,
  };
}

function canReadShellEarly(prepared: PreparedConnection): boolean {
  if (prepared.httpAuthorization === null) {
    if (prepared.target._tag !== "PrimaryConnectionTarget") return false;
  } else if (prepared.target._tag !== "HubProxyConnectionTarget") {
    return true;
  }
  try {
    const http = new URL(prepared.httpBaseUrl);
    const socket = new URL(prepared.socketUrl);
    http.protocol = http.protocol === "https:" ? "wss:" : "ws:";
    return (
      http.origin === socket.origin && socket.pathname === `${http.pathname.replace(/\/$/, "")}/ws`
    );
  } catch {
    return false;
  }
}

interface EarlyShellLoad {
  readonly prepared: PreparedConnection;
  readonly identity: ShellOriginIdentity;
  readonly fiber: Fiber.Fiber<Option.Option<ShellSnapshotLoader.ShellHttpAnswer>>;
  readonly claimed: boolean;
}

function samePreparedConnection(left: PreparedConnection, right: PreparedConnection): boolean {
  return (
    left.target === right.target &&
    left.httpBaseUrl === right.httpBaseUrl &&
    left.socketUrl === right.socketUrl &&
    left.descriptor === right.descriptor
  );
}

interface LiveShell {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly origin: Persistence.ShellCacheOrigin | undefined;
}

export const makeEnvironmentShellState = Effect.fn("EnvironmentShellState.make")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const snapshotLoader = yield* ShellSnapshotLoader.ShellSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadShell(environmentId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached environment shell.").pipe(
        Effect.annotateLogs({
          environmentId,
          ...safeErrorLogAttributes(error),
        }),
        Effect.as(Option.none<Persistence.CachedShellSnapshot>()),
      ),
    ),
  );
  const cachedMeta = yield* cache
    .loadShellMeta(environmentId)
    .pipe(Effect.catch(() => Effect.succeedNone));
  const cachedSnapshot = Option.map(cached, ({ origin: _origin, ...rows }) =>
    withoutDeferredPullRequests(rows),
  );
  const state = yield* SubscriptionRef.make<EnvironmentShellState>({
    ...EMPTY_SHELL_STATE,
    snapshot: cachedSnapshot,
    ...(Option.isSome(cachedMeta) ? { meta: cachedMeta.value } : {}),
    status: shellStatusForSnapshot(cachedSnapshot),
  });
  const awaitingCompletion = yield* Ref.make(false);
  const lastAuthoritativeSession = yield* Ref.make<RpcSession | null>(null);
  const sessionOrigins = new WeakMap<RpcSession, ShellOriginIdentity | null>();
  const origin = yield* Ref.make(Option.getOrUndefined(cached)?.origin);
  const reloadRequests = yield* Queue.sliding<void>(1);
  const latestLiveSnapshot = yield* Ref.make<Option.Option<LiveShell>>(Option.none());
  const persistence = yield* Queue.sliding<OrchestrationV2ShellSnapshot>(1);

  const persistenceLock = yield* Semaphore.make(1);
  let lastPersisted: LiveShell | undefined;
  // Rows still waiting for their deferred pull request links, which must not be saved:
  // the cache would keep them without links until the next server refresh.
  let pendingLinkRows: ReadonlySet<OrchestrationV2ThreadShell> = new Set();
  const persistLatest = Effect.fn("EnvironmentShellState.persistLatest")(function* (
    flush: boolean,
  ) {
    while (true) {
      const latest = yield* Ref.get(latestLiveSnapshot);
      if (Option.isNone(latest) || latest.value === lastPersisted) return;
      const { snapshot, origin } = latest.value;
      if (snapshot.threads.some((thread) => pendingLinkRows.has(thread))) return;
      if (
        lastPersisted !== undefined &&
        origin === lastPersisted.origin &&
        snapshot.snapshotSequence >= lastPersisted.snapshot.snapshotSequence &&
        snapshot.schemaVersion === lastPersisted.snapshot.schemaVersion &&
        snapshot.projects === lastPersisted.snapshot.projects &&
        snapshot.threads === lastPersisted.snapshot.threads &&
        snapshot.archivedThreads === lastPersisted.snapshot.archivedThreads &&
        snapshot.olderSettled === lastPersisted.snapshot.olderSettled
      ) {
        // Keep the live cursor without rewriting the rows. Remember it here too so a
        // later authoritative reset to a lower sequence still reaches the cache.
        lastPersisted = latest.value;
        return;
      }
      const saved = yield* cache.saveShell(environmentId, snapshot, origin).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist environment shell cache.").pipe(
            Effect.annotateLogs({ environmentId, ...safeErrorLogAttributes(error) }),
            Effect.as(false),
          ),
        ),
      );
      if (!saved) return;
      const meta = {
        snapshotSequence: snapshot.snapshotSequence,
        capturedAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* cache
        .saveShellMeta(environmentId, meta)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not persist shell cache metadata.", { error }),
          ),
        );
      yield* SubscriptionRef.update(state, (current) => ({ ...current, meta }));
      lastPersisted = latest.value;
      if (!flush) return;
    }
  }, persistenceLock.withPermit);
  const persist = () => persistLatest(false);
  const flushLiveShellSnapshot = persistLatest(true);

  // Register before scoped worker fibers so reverse finalizer order interrupts
  // those fibers first and this flush sees a stable latestLiveSnapshot.
  yield* Effect.addFinalizer(() => flushLiveShellSnapshot);

  yield* runCachePersistence(persistence, persist).pipe(Effect.forkScoped);

  const setDisconnected = Ref.set(awaitingCompletion, false).pipe(
    Effect.andThen(
      SubscriptionRef.update(state, (current) => ({
        ...current,
        status: shellStatusForSnapshot(current.snapshot),
      })),
    ),
    Effect.andThen(flushLiveShellSnapshot.pipe(Effect.forkScoped)),
    Effect.asVoid,
  );
  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setStreamError = (error: unknown) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(Effect.logWarning("Could not synchronize the environment shell.")),
      Effect.annotateLogs({
        environmentId,
        ...safeErrorLogAttributes(error),
      }),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status: shellStatusForSnapshot(current.snapshot),
          error: Option.some(SHELL_SYNCHRONIZATION_ERROR_MESSAGE),
        })),
      ),
    );

  // Server items and deferred link fills both read the snapshot and write it back; one at a
  // time, so neither can overwrite what the other wrote in between.
  const snapshotWriteLock = yield* Semaphore.make(1);

  const applyItems = Effect.fn("EnvironmentShellState.applyItems")(function* (
    items: ReadonlyArray<readonly [RpcSession, OrchestrationV2ShellStreamItem]>,
    pendingLinkIds?: ReadonlySet<ThreadId>,
  ) {
    const initial = yield* SubscriptionRef.get(state);
    const currentSession = yield* SubscriptionRef.get(supervisor.session);
    let waiting = yield* Ref.get(awaitingCompletion);
    let next = initial;
    let receivedSnapshot = false;
    let refused = false;
    let deltas: Array<ShellStreamEvent> = [];
    const flushDeltas = () => {
      if (deltas.length > 0 && Option.isSome(next.snapshot)) {
        let sequence = next.snapshot.value.snapshotSequence;
        let removedAt: Map<ThreadId, number> | undefined;
        for (const delta of deltas) {
          if (delta.sequence <= sequence) continue;
          switch (delta.kind) {
            case "thread.removed":
              removedAt ??= new Map(next.removedAt);
              removedAt.set(delta.threadId, delta.sequence);
              break;
            case "thread.updated":
            case "project.updated":
            case "project.removed":
              break;
            default:
              continue;
          }
          sequence = delta.sequence;
        }
        next = {
          ...next,
          removedAt: removedAt ?? next.removedAt,
          snapshot: Option.some(applyShellStreamEvents(next.snapshot.value, deltas)),
          status: waiting ? "synchronizing" : "live",
          error: Option.none(),
        };
      }
      deltas = [];
    };
    for (const [producerSession, item] of items) {
      if (Option.isNone(currentSession) || producerSession !== currentSession.value) continue;
      if (item.kind === "snapshot-required") {
        refused = true;
        continue;
      }
      if (item.kind !== "snapshot" && item.kind !== "synchronized") {
        deltas.push(item);
        continue;
      }
      // Snapshots can reset the cursor; completion markers change the sync status.
      flushDeltas();
      if (item.kind === "synchronized") {
        waiting = false;
        if (Option.isSome(next.snapshot)) {
          next = {
            ...next,
            status: "live",
            error: Option.none(),
            generation: next.generation === 0 ? ++lastShellGeneration : next.generation,
            authoritativeSession: producerSession,
          };
        }
        continue;
      }
      const authoritative = item.resolvedRepositoryIdentityRoots === undefined;
      const nextSnapshot = mergeShellSnapshotProjects(
        Option.getOrNull(next.snapshot),
        item.snapshot,
        item.resolvedRepositoryIdentityRoots === undefined
          ? undefined
          : { resolvedRepositoryIdentityRoots: item.resolvedRepositoryIdentityRoots },
      );
      if (authoritative) receivedSnapshot = true;
      next = {
        snapshot: Option.some(nextSnapshot),
        status: waiting ? "synchronizing" : "live",
        error: Option.none(),
        generation: authoritative ? ++lastShellGeneration : next.generation,
        authoritativeSession: authoritative ? producerSession : next.authoritativeSession,
        removedAt: authoritative ? EMPTY_REMOVALS : next.removedAt,
      };
    }
    flushDeltas();
    if (refused) {
      yield* Ref.set(origin, undefined);
      yield* Ref.set(lastAuthoritativeSession, null);
      yield* Queue.offer(reloadRequests, undefined);
      return;
    }
    yield* Ref.set(awaitingCompletion, waiting);
    if (next === initial) return;
    const session = next.authoritativeSession;
    if (session !== null) {
      yield* Ref.set(lastAuthoritativeSession, session);
      if (receivedSnapshot) {
        const identity = sessionOrigins.get(session);
        yield* Ref.set(
          origin,
          identity == null
            ? undefined
            : {
                ...identity,
                snapshotAt: yield* Clock.currentTimeMillis,
              },
        );
      }
    }
    if (pendingLinkIds !== undefined && Option.isSome(next.snapshot)) {
      pendingLinkRows = new Set(
        next.snapshot.value.threads.filter((thread) => pendingLinkIds.has(thread.id)),
      );
    }
    if (Option.isSome(next.snapshot)) {
      yield* Ref.set(
        latestLiveSnapshot,
        Option.some({
          snapshot: next.snapshot.value,
          origin: yield* Ref.get(origin),
        }),
      );
    }
    yield* SubscriptionRef.set(state, next);
    if (next.snapshot !== initial.snapshot && Option.isSome(next.snapshot)) {
      yield* Queue.offer(persistence, next.snapshot.value);
    }
  }, snapshotWriteLock.withPermit);

  const hydrateFromHub = Effect.fn("EnvironmentShellState.hydrateFromHub")(function* (
    snapshot: OrchestrationV2ShellSnapshot,
    capturedAt: string,
  ) {
    const session = yield* SubscriptionRef.get(supervisor.session);
    if (Option.isSome(session) && (yield* Ref.get(lastAuthoritativeSession)) === session.value)
      return false;
    const current = yield* SubscriptionRef.get(state);
    if (
      Option.isSome(current.snapshot) &&
      snapshot.snapshotSequence < current.snapshot.value.snapshotSequence
    )
      return false;
    const meta = { snapshotSequence: snapshot.snapshotSequence, capturedAt };
    yield* persistenceLock.withPermit(
      Effect.gen(function* () {
        yield* Ref.set(latestLiveSnapshot, Option.none());
        yield* cache.saveShell(environmentId, snapshot);
        yield* cache.saveShellMeta(environmentId, meta);
      }).pipe(
        Effect.catch((error) => Effect.logWarning("Could not persist a hub snapshot.", { error })),
      ),
    );
    yield* Ref.set(origin, undefined);
    yield* Ref.set(lastAuthoritativeSession, null);
    yield* SubscriptionRef.set(state, {
      ...current,
      snapshot: Option.some(snapshot),
      authoritativeSession: null,
      meta,
    });
    return true;
  }, snapshotWriteLock.withPermit);

  const stateScope = yield* Effect.scope;
  // Each full snapshot supersedes the previous one's fill; links from an older snapshot must
  // not land on rows a newer snapshot reused.

  let activeFill: Fiber.Fiber<void> | undefined;
  const cancelActiveFill = Effect.suspend(() => {
    const fill = activeFill;
    activeFill = undefined;
    return fill === undefined ? Effect.void : Fiber.interrupt(fill);
  });
  const fillDeferredPullRequests = Effect.fnUntraced(function* (
    source: DeferredShellSnapshot,
    applied: OrchestrationV2ShellSnapshot,
  ) {
    yield* cancelActiveFill;
    if (source.loadPullRequests === undefined) return;
    const arrivedRows = new Set(applied.threads);
    const arrivedIds = new Set(source.threads.map((thread) => thread.id));
    pendingLinkRows = new Set(applied.threads.filter((thread) => arrivedIds.has(thread.id)));
    activeFill = yield* source.loadPullRequests.pipe(
      Effect.flatMap((linksByThreadId) =>
        writeFilledLinks(linksByThreadId, arrivedRows, arrivedIds),
      ),
      Effect.forkIn(stateScope),
    );
  });
  const writeFilledLinks = Effect.fnUntraced(
    function* (
      linksByThreadId: ReadonlyMap<ThreadId, ReadonlyArray<ThreadPullRequestLink>>,
      arrivedRows: ReadonlySet<OrchestrationV2ThreadShell>,
      arrivedIds: ReadonlySet<ThreadId>,
    ) {
      const filled = yield* SubscriptionRef.modify(
        state,
        (current): [Option.Option<OrchestrationV2ShellSnapshot>, EnvironmentShellState] => {
          if (Option.isNone(current.snapshot)) return [Option.none(), current];
          const snapshot = current.snapshot.value;
          let changed = false;
          const threads = snapshot.threads.map((thread) => {
            if (!arrivedRows.has(thread) || !arrivedIds.has(thread.id)) return thread;
            const links = linksByThreadId.get(thread.id);
            if (sameThreadPullRequests(thread.pullRequests, links)) return thread;
            changed = true;
            if (links === undefined) {
              const { pullRequests: _previous, ...row } = thread;
              return row;
            }
            return { ...thread, pullRequests: links };
          });
          if (!changed) return [Option.none(), current];
          const next = { ...snapshot, threads };
          return [Option.some(next), { ...current, snapshot: Option.some(next) }];
        },
      );
      pendingLinkRows = new Set();
      const live = yield* Ref.get(latestLiveSnapshot);
      if (Option.isNone(live)) return;
      const snapshot = Option.getOrElse(filled, () => live.value.snapshot);
      yield* Ref.set(latestLiveSnapshot, Option.some({ snapshot, origin: live.value.origin }));
      yield* Queue.offer(persistence, snapshot);
    },
    (effect) => snapshotWriteLock.withPermit(effect),
  );
  if (Option.isSome(cached) && Option.isSome(cachedSnapshot)) {
    yield* fillDeferredPullRequests(cached.value, cachedSnapshot.value);
  }

  const heldShellCursor = Effect.fnUntraced(function* (
    identity: ShellOriginIdentity | null,
    session?: RpcSession,
  ) {
    const held = Option.getOrUndefined((yield* SubscriptionRef.get(state)).snapshot);
    if (held === undefined) return undefined;
    const sameLegacySession =
      identity === null &&
      session !== undefined &&
      (yield* Ref.get(lastAuthoritativeSession)) === session;
    return sameLegacySession ||
      canResumeFrom(yield* Ref.get(origin), identity, yield* Clock.currentTimeMillis)
      ? held.snapshotSequence
      : undefined;
  });

  const readShell = Effect.fn("EnvironmentShellState.readOverHttp")(function* (
    prepared: PreparedConnection,
    omitIdleSubagents: boolean,
    omitOlderSettled: boolean,
    identity: ShellOriginIdentity | null,
  ) {
    const resumeFrom = yield* snapshotWriteLock.withPermit(heldShellCursor(identity));
    return yield* snapshotLoader.load(prepared, {
      omitIdleSubagents,
      omitOlderSettled,
      ...(resumeFrom === undefined ? {} : { resumeFrom }),
    });
  });

  const earlyLoad = yield* SynchronizedRef.make<EarlyShellLoad | null>(null);
  const useEarlyLoad = (prepared: PreparedConnection | null, claim: boolean) =>
    SynchronizedRef.modifyEffect(
      earlyLoad,
      Effect.fnUntraced(function* (current) {
        if (
          current !== null &&
          prepared !== null &&
          samePreparedConnection(current.prepared, prepared)
        ) {
          if (current.claimed && current.fiber.pollUnsafe() !== undefined)
            return [null, null] as const;
          return claim
            ? ([current, { ...current, claimed: true }] as const)
            : ([current, current] as const);
        }
        if (current !== null) yield* Fiber.interrupt(current.fiber);
        if (prepared === null || !canReadShellEarly(prepared)) return [null, null] as const;
        const descriptor = prepared.descriptor;
        if (descriptor?.capabilities.shellThreadFamilies === undefined)
          return [null, null] as const;
        const identity = shellIdentity(descriptor, descriptor.capabilities);
        if (identity === null) return [null, null] as const;
        const fiber = yield* readShell(
          prepared,
          identity.omitIdleSubagents,
          identity.omitOlderSettled,
          identity,
        ).pipe(Effect.forkIn(stateScope));
        const next = { prepared, identity, fiber, claimed: claim };
        return [next, next] as const;
      }),
    ).pipe(Effect.uninterruptible);

  yield* SubscriptionRef.changes(supervisor.prepared).pipe(
    Stream.runForEach(() =>
      SubscriptionRef.get(supervisor.prepared).pipe(
        Effect.flatMap((prepared) => useEarlyLoad(Option.getOrNull(prepared), false)),
      ),
    ),
    Effect.forkScoped,
  );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamicWithSession(
      ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      Effect.fn("EnvironmentShellState.makeSubscribeInput")(function* (session) {
        const { supportsCompletionMarker, omitIdleSubagents, omitOlderSettled, identity } =
          yield* session.initialConfig.pipe(
            Effect.map((config) => {
              const omitIdleSubagents = config.shellThreadFamilies === true;
              const omitOlderSettled = config.shellOlderSettled === true && omitIdleSubagents;
              return {
                supportsCompletionMarker: config.shellResumeCompletionMarker === true,
                omitIdleSubagents,
                omitOlderSettled,
                identity: shellIdentity(config.environment, config),
              };
            }),
            Effect.orElseSucceed(() => ({
              supportsCompletionMarker: false,
              omitIdleSubagents: false,
              omitOlderSettled: false,
              identity: null,
            })),
          );
        sessionOrigins.set(session, identity);
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        const hadResumeCursor =
          (yield* snapshotWriteLock.withPermit(heldShellCursor(identity, session))) !== undefined;
        const early = yield* useEarlyLoad(
          Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared)),
          true,
        );
        let loaded = Option.none<ShellSnapshotLoader.ShellHttpAnswer>();
        if (early !== null && sameShellIdentity(early.identity, identity)) {
          const wait = Fiber.await(early.fiber);
          if (hadResumeCursor) {
            const answered = yield* wait.pipe(Effect.timeoutOption("3 seconds"));
            if (Option.isSome(answered) && Exit.isSuccess(answered.value))
              loaded = answered.value.value;
            if (Option.isNone(answered)) yield* Fiber.interrupt(early.fiber);
          } else {
            const answered = yield* wait;
            if (Exit.isSuccess(answered)) loaded = answered.value;
          }
        } else {
          if (early !== null) yield* Fiber.interrupt(early.fiber);
          if (!hadResumeCursor) {
            const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
              Effect.flatMap(
                Option.match({
                  onSome: Effect.succeed,
                  onNone: () =>
                    SubscriptionRef.changes(supervisor.prepared).pipe(
                      Stream.filter(Option.isSome),
                      Stream.map((value) => value.value),
                      Stream.runHead,
                      Effect.map(Option.getOrThrow),
                    ),
                }),
              ),
            );
            loaded = yield* readShell(prepared, omitIdleSubagents, omitOlderSettled, identity);
          }
        }
        let appliedHttpSnapshot = false;
        let knownProjectIdentities: string | undefined;
        if (Option.isSome(loaded) && !("resumable" in loaded.value)) {
          const { projectIdentities, ...deferred } = loaded.value;
          yield* cancelActiveFill;
          const previous = yield* SubscriptionRef.get(state);
          const snapshot = reuseUnchangedThreadShells(
            Option.getOrNull(previous.snapshot),
            withoutDeferredPullRequests(deferred),
          );
          const pendingLinkIds = new Set(
            deferred.loadPullRequests === undefined
              ? []
              : deferred.threads.map((thread) => thread.id),
          );
          yield* applyItems([[session, { kind: "snapshot", snapshot }]], pendingLinkIds);
          const current = yield* SubscriptionRef.get(state);
          if (current.authoritativeSession === session && Option.isSome(current.snapshot)) {
            yield* fillDeferredPullRequests(deferred, current.snapshot.value);
            appliedHttpSnapshot = true;
          }
          knownProjectIdentities = projectIdentities;
        }

        return yield* snapshotWriteLock.withPermit(
          Effect.gen(function* () {
            const options = {
              ...(omitIdleSubagents ? { omitIdleSubagents: true as const } : {}),
              ...(omitOlderSettled ? { omitOlderSettled: true as const } : {}),
              ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
            };
            const afterSequence = yield* heldShellCursor(identity, session);
            if (afterSequence === undefined) return options;

            // Once the cursor is chosen, hub hydration must leave its rows in place.
            yield* Ref.set(lastAuthoritativeSession, session);
            if (!supportsCompletionMarker) {
              yield* SubscriptionRef.update(state, (value) => ({
                ...value,
                status: "live" as const,
                error: Option.none(),
              }));
            }
            return {
              ...options,
              afterSequence,
              ...(appliedHttpSnapshot ? {} : { httpSnapshotFallback: true as const }),
              ...(knownProjectIdentities === undefined ? {} : { knownProjectIdentities }),
            };
          }),
        );
      }),
      {
        onExpectedFailure: (cause) => setStreamError(Cause.squash(cause)),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: Stream.merge(foregroundResubscriptions, Stream.fromQueue(reloadRequests)),
      },
    ).pipe(Stream.runForEachArray((items) => applyItems(items))),
  );
  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  yield* watchHubProxySnapshot(hydrateFromHub).pipe(Effect.forkScoped);
  return Object.assign(state, { hydrateFromHub });
});

function shellStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentShellState().pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export interface EnvironmentShellSummary {
  readonly hasSnapshot: boolean;
  readonly hasSynchronizingShell: boolean;
  readonly hasCachedShell: boolean;
  readonly hasLiveShell: boolean;
  readonly firstError: string | null;
}

const EMPTY_ENVIRONMENT_SHELL_SUMMARY: EnvironmentShellSummary = Object.freeze({
  hasSnapshot: false,
  hasSynchronizingShell: false,
  hasCachedShell: false,
  hasLiveShell: false,
  firstError: null,
});

const EMPTY_SERVER_CONFIGS: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();

function shellSummariesEqual(
  left: EnvironmentShellSummary,
  right: EnvironmentShellSummary,
): boolean {
  return (
    left.hasSnapshot === right.hasSnapshot &&
    left.hasSynchronizingShell === right.hasSynchronizingShell &&
    left.hasCachedShell === right.hasCachedShell &&
    left.hasLiveShell === right.hasLiveShell &&
    left.firstError === right.firstError
  );
}

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentShellSummaryAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  let previousSummary = EMPTY_ENVIRONMENT_SHELL_SUMMARY;
  return Atom.make((get) => {
    let hasSnapshot = false;
    let hasSynchronizingShell = false;
    let hasCachedShell = false;
    let hasLiveShell = false;
    let firstError: string | null = null;

    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const state = get(input.shellStateValueAtom(environmentId));
      hasSynchronizingShell ||= state.status === "synchronizing";
      hasCachedShell ||= state.status === "cached";
      hasLiveShell ||= state.status === "live";
      if (firstError === null) {
        firstError = Option.getOrNull(state.error);
      }
      if (Option.isNone(state.snapshot)) {
        continue;
      }
      hasSnapshot = true;
    }

    const next: EnvironmentShellSummary = {
      hasSnapshot,
      hasSynchronizingShell,
      hasCachedShell,
      hasLiveShell,
      firstError,
    };
    if (shellSummariesEqual(previousSummary, next)) {
      return previousSummary;
    }
    previousSummary = next;
    return previousSummary;
  }).pipe(Atom.withLabel("environment-shell-summary"));
}

export function createEnvironmentServerConfigsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  let previousServerConfigs = EMPTY_SERVER_CONFIGS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, ServerConfig>();
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const config = get(input.serverConfigValueAtom(environmentId));
      if (config !== null) {
        next.set(environmentId, config);
      }
    }
    if (mapsEqual(previousServerConfigs, next)) {
      return previousServerConfigs;
    }
    previousServerConfigs = next;
    return previousServerConfigs;
  }).pipe(Atom.withLabel("environment-server-configs"));
}

/**
 * Every shell push replaces the state, so views that gate on load progress read these
 * primitives instead and stay put while threads stream.
 */
function createEnvironmentShellProgressAtoms(
  stateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>,
) {
  return {
    statusAtom: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => get(stateValueAtom(environmentId)).status).pipe(
        Atom.withLabel(`environment-shell-status:${environmentId}`),
      ),
    ),
    hasSnapshotAtom: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => Option.isSome(get(stateValueAtom(environmentId)).snapshot)).pipe(
        Atom.withLabel(`environment-shell-has-snapshot:${environmentId}`),
      ),
    ),
  };
}

export function createEnvironmentShellAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | Persistence.EnvironmentCacheStore
    | ShellSnapshotLoader.ShellSnapshotLoader
    | R,
    E
  >,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(shellStateChanges(environmentId), {
      initialValue: EMPTY_SHELL_STATE,
    }),
  );

  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(stateAtom(environmentId))), () => EMPTY_SHELL_STATE),
    ).pipe(Atom.withLabel(`environment-shell-state-value:${environmentId}`)),
  );

  const { statusAtom, hasSnapshotAtom } = createEnvironmentShellProgressAtoms(stateValueAtom);

  return {
    stateAtom,
    stateValueAtom,
    statusAtom,
    hasSnapshotAtom,
    offlineSnapshotAge: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => offlineSnapshotCapturedAt(get(stateValueAtom(environmentId)))),
    ),
  };
}

export function offlineSnapshotCapturedAt(state: EnvironmentShellState): string | null {
  return Option.isSome(state.snapshot) &&
    state.meta?.snapshotSequence === state.snapshot.value.snapshotSequence
    ? state.meta.capturedAt
    : null;
}

export * from "./models.ts";
export * from "./shellCommands.ts";
export * from "./shellReducer.ts";
export * from "./shellPullRequests.ts";
export * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
export * from "./snapshots.ts";
export * from "./steadyShells.ts";
