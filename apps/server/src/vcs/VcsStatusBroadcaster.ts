import { VcsAutomaticFetchInterval, VcsAutoPullPolicy } from "./vcsBackgroundPolicy.ts";
export {
  VcsAutomaticFetchInterval,
  VcsAutoPullPolicy,
  layerAutomaticFetchInterval,
  layerAutoPullPolicy,
} from "./vcsBackgroundPolicy.ts";
import { makeBranchUpdates } from "./branchUpdates.ts";
import { remoteRefreshFailureDiagnostics } from "./vcsStatusDiagnostics.ts";
import { makeHeadWatchers } from "./headWatchers.ts";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import { sshHostsRefusal } from "@goat/ssh/hostAccess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsBranchStatus,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
  VcsStatusSubscriptionInput,
} from "@goat/contracts";
import { DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL, GitManagerError } from "@goat/contracts";
import { mergeGitStatusParts } from "@goat/shared/git";
import * as KeyedLock from "@goat/shared/KeyedLock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as AutomationHold from "../automationHold.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";

const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const MAX_STATUS_REFRESH_WORKERS = 16;
interface CachedValue<T> {
  readonly fingerprint: string;
  readonly value: T;
}

interface CachedRemoteStatus extends CachedValue<VcsStatusRemoteResult | null> {
  readonly branch: string | null;
}

interface VcsStatusChange {
  readonly cwd: string;
  readonly events: Arr.NonEmptyReadonlyArray<VcsStatusStreamEvent>;
}

interface CachedVcsStatus {
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote: CachedRemoteStatus | null;
}

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
  readonly demandCwds: Ref.Ref<ReadonlyMap<string, number>>;
}

function remoteRefreshFailureDelay(
  consecutiveFailures: number,
  configuredInterval: Duration.Duration,
) {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs =
    Duration.toMillis(VCS_STATUS_REFRESH_FAILURE_BASE_DELAY) * Math.pow(2, exponent);
  const cappedBackoff = Duration.min(
    Duration.millis(backoffMs),
    VCS_STATUS_REFRESH_FAILURE_MAX_DELAY,
  );
  return Duration.max(configuredInterval, cappedBackoff);
}

export class VcsStatusBroadcaster extends Context.Service<
  VcsStatusBroadcaster,
  {
    readonly streamBranchStatus: (
      input: VcsStatusInput,
    ) => Stream.Stream<VcsBranchStatus, GitManagerServiceError>;
    readonly refreshBranchStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsBranchStatus, GitManagerServiceError>;
    readonly getStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshLocalStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    /**
     * For a checkout someone is waiting on. Returns once the new branch is published, so the
     * caller's reply does not outrun it, and finishes the slower remote read in the background.
     */
    readonly refreshAfterCheckout: (cwd: string) => Effect.Effect<void>;
    readonly refreshStatus: (
      cwd: string,
      options?: { readonly localOnly?: boolean },
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshPullRequestStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly streamStatus: (
      input: VcsStatusSubscriptionInput,
    ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
  }
>()("goat/vcs/VcsStatusBroadcaster") {}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

const normalizeCwd = (cwd: string) =>
  Effect.service(FileSystem.FileSystem).pipe(
    Effect.flatMap((fs) => fs.realPath(cwd)),
    Effect.orElseSucceed(() => cwd),
  );

/** @public */
export const make = Effect.gen(function* () {
  const automationHold = yield* AutomationHold.AutomationHold;
  const automaticFetchInterval = yield* VcsAutomaticFetchInterval;
  const autoPullPolicy = yield* VcsAutoPullPolicy;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const fs = yield* FileSystem.FileSystem;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<VcsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const detailedSubscribers = new Map<string, number>();
  const branchUpdates = yield* makeBranchUpdates;
  let branchObservation = 0;
  const headDuringLocalRead = new Map<
    string,
    (VcsBranchStatus & { readonly observation: number }) | null
  >();
  const publishBranch = branchUpdates.publish;
  const localRefreshLocks = yield* KeyedLock.make<string>();
  const cache = new Map<string, CachedVcsStatus>();
  // One permit per cwd for remote reads that write the cache. Without it a
  // periodic poll that started before an agent creates a PR can finish after the
  // turn-end refresh and overwrite the fresh PR with its stale `pr: null`.
  const remoteWriteLocks = yield* KeyedLock.make<string>();
  const withRemoteWriteLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    remoteWriteLocks.withLock(cwd, effect);
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")((cwd: string) =>
    Effect.sync(() => cache.get(cwd) ?? null),
  );

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (
      cwd: string,
      local: VcsStatusLocalResult,
      observation: number,
      options?: { publish?: boolean },
    ) {
      const nextLocal = { fingerprint: fingerprintStatusPart(local), value: local };
      const accepted = yield* Effect.sync(() => {
        const head = headDuringLocalRead.get(cwd);
        if (
          head &&
          head.observation > observation &&
          (head.refName !== local.refName || head.isRepo !== local.isRepo)
        ) {
          return false;
        }
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const remote =
          local.isRepo && previous.remote?.branch === local.refName ? previous.remote : null;
        cache.set(cwd, { local: nextLocal, remote });
        if (options?.publish) {
          const events: VcsStatusStreamEvent[] = [];
          if (previous.remote !== remote) events.push({ _tag: "remoteUpdated", remote: null });
          if (previous.local?.fingerprint !== nextLocal.fingerprint) {
            events.push({ _tag: "localUpdated", local });
          }
          // Enqueue both events before the unbounded PubSub wakes any subscriber.
          if (Arr.isArrayNonEmpty(events)) PubSub.publishUnsafe(changesPubSub, { cwd, events });
        }
        return true;
      });
      if (!accepted) return null;
      yield* publishBranch(cwd, local, observation);
      return local;
    },
  );

  const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
    function* (cwd: string, remote: CachedRemoteStatus | null, options?: { publish?: boolean }) {
      const [changed, value] = yield* Effect.sync(() => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const local = previous.local?.value;
        const next = local?.isRepo && remote?.branch === local.refName ? remote : null;
        cache.set(cwd, { ...previous, remote: next });
        return [previous.remote?.fingerprint !== next?.fingerprint, next?.value ?? null] as const;
      });
      if (options?.publish && changed) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          events: [{ _tag: "remoteUpdated", remote: value }],
        });
      }
      return value;
    },
  );

  const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(
    function* (cwd: string, options?: { publish?: boolean }) {
      headDuringLocalRead.set(cwd, null);
      while (true) {
        const observation = ++branchObservation;
        const local = yield* workflow.localStatus({ cwd });
        const updated = yield* updateCachedLocalStatus(cwd, local, observation, options);
        if (updated !== null) return updated;
        // The Git driver's detailed cache can also contain the superseded read.
        yield* workflow.invalidateLocalStatus(cwd);
      }
    },
    (effect, cwd, _options?) =>
      effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            headDuringLocalRead.delete(cwd);
          }),
        ),
      ),
  );

  const getOrLoadLocalStatusUnlocked = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(
    function* (cwd: string, revalidateHead: boolean) {
      const cached = yield* getCachedStatus(cwd);
      if (cached?.local) {
        if (!revalidateHead) return cached.local.value;
        const { refName, isRepo } = yield* readHeadBranch(cwd);
        if (refName === cached.local.value.refName && isRepo === cached.local.value.isRepo) {
          return cached.local.value;
        }
        localRefreshResults.delete(cwd);
        yield* workflow.invalidateLocalStatus(cwd);
        return yield* loadLocalStatus(cwd, { publish: true });
      }
      return yield* loadLocalStatus(cwd);
    },
  );
  const getOrLoadLocalStatus = (cwd: string, revalidateHead = false) =>
    localRefreshLocks.withLock(cwd, getOrLoadLocalStatusUnlocked(cwd, revalidateHead));

  const getStatusParts = Effect.fn("VcsStatusBroadcaster.getStatusParts")(function* (cwd: string) {
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      return { local: cached.local.value, remote: cached.remote?.value ?? null };
    }
    return { local: yield* getOrLoadLocalStatus(cwd), remote: null };
  });

  const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

  const getStatus: VcsStatusBroadcaster["Service"]["getStatus"] = Effect.fn(
    "VcsStatusBroadcaster.getStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local && cached.remote) {
      return mergeGitStatusParts(cached.local.value, cached.remote.value);
    }
    yield* getOrLoadLocalStatus(cwd);
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const latest = yield* getCachedStatus(cwd);
        const refreshUpstream = !Duration.isZero(yield* automaticFetchInterval);
        const remote = latest?.remote ?? (yield* readRemoteStatus(cwd, { refreshUpstream }));
        yield* updateCachedRemoteStatus(cwd, remote);
        const parts = yield* getStatusParts(cwd);
        return mergeGitStatusParts(parts.local, parts.remote);
      }),
    );
  });

  // A refresh that started after a request saw every change that request could mean, so queued
  // callers share it instead of each running git status again.
  const localRefreshRequests = new Map<string, number>();
  const localRefreshResults = new Map<
    string,
    { readonly startedAt: number; readonly local: VcsStatusLocalResult }
  >();
  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string) {
      const requestedAt = (localRefreshRequests.get(cwd) ?? 0) + 1;
      localRefreshRequests.set(cwd, requestedAt);
      return yield* localRefreshLocks.withLock(
        cwd,
        Effect.gen(function* () {
          const shared = localRefreshResults.get(cwd);
          if (shared !== undefined && shared.startedAt >= requestedAt) return shared.local;
          const startedAt = localRefreshRequests.get(cwd) ?? requestedAt;
          yield* workflow.invalidateLocalStatus(cwd);
          const local = yield* loadLocalStatus(cwd, { publish: true });
          localRefreshResults.set(cwd, { startedAt, local });
          return local;
        }),
      );
    },
  );

  const refreshLocalStatus: VcsStatusBroadcaster["Service"]["refreshLocalStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshLocalStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    const local = yield* refreshLocalStatusCore(cwd);
    const cached = yield* getCachedStatus(cwd);
    if (cached?.remote?.value?.hasUpstream) {
      const divergence = yield* workflow.upstreamDivergence(cwd);
      const latest = yield* getCachedStatus(cwd);
      if (divergence && latest?.remote?.value && latest.remote.branch === divergence.refName) {
        const value = {
          ...latest.remote.value,
          aheadCount: divergence.aheadCount,
          behindCount: divergence.behindCount,
        };
        yield* updateCachedRemoteStatus(
          cwd,
          { branch: divergence.refName, value, fingerprint: fingerprintStatusPart(value) },
          { publish: true },
        );
      }
    }
    return local;
  });

  const readRemoteStatus = Effect.fn("VcsStatusBroadcaster.readRemoteStatus")(function* (
    cwd: string,
    options?: Parameters<GitWorkflowService.GitWorkflowService["Service"]["remoteStatus"]>[1],
  ) {
    const branch = yield* workflow.currentBranch(cwd);
    // GitManager's remote TTL cache is keyed by cwd, not the checked-out branch.
    yield* workflow.invalidateRemoteStatus(cwd);
    const previousRemote = (yield* getCachedStatus(cwd))?.remote;
    const remote = yield* workflow.remoteStatus({ cwd }, options);
    const latest = yield* getCachedStatus(cwd);
    const refreshed =
      remote?.hasUpstream && latest?.remote !== previousRemote && latest?.remote?.branch === branch
        ? yield* workflow.upstreamDivergence(cwd)
        : null;
    const value =
      remote && refreshed?.refName === branch
        ? { ...remote, aheadCount: refreshed.aheadCount, behindCount: refreshed.behindCount }
        : remote;
    const currentBranch = yield* workflow.currentBranch(cwd);
    const cached = yield* getCachedStatus(cwd);
    if (branch !== currentBranch || cached?.local?.value.refName !== currentBranch) {
      yield* refreshLocalStatusCore(cwd);
    }
    return branch === currentBranch
      ? { branch, value, fingerprint: fingerprintStatusPart(value) }
      : null;
  });

  const maybeAutoPull = Effect.fn("VcsStatusBroadcaster.maybeAutoPull")(function* (
    cwd: string,
    remoteRead: CachedRemoteStatus | null,
    policyCwds: ReadonlyArray<string>,
  ) {
    if ((yield* automationHold.current) !== null) return null;
    if ((yield* sshHostsRefusal) !== undefined) return null;
    const remote = remoteRead?.value ?? null;

    let pullAttempted = false;
    return yield* Effect.gen(function* () {
      const autoPullEnabled = (yield* Effect.forEach(policyCwds, autoPullPolicy.isEnabled, {
        concurrency: "unbounded",
      })).some(Boolean);
      if (
        remote === null ||
        !remote.hasUpstream ||
        remote.aheadCount > 0 ||
        remote.behindCount <= 0 ||
        !autoPullEnabled
      ) {
        return null;
      }

      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      if (
        !local.isRepo ||
        !local.isDefaultRef ||
        local.hasWorkingTreeChanges ||
        local.refName !== remoteRead?.branch
      )
        return null;

      pullAttempted = true;
      yield* workflow.pullCurrentBranch(cwd);
      yield* workflow.invalidateStatus(cwd);
      yield* refreshLocalStatusCore(cwd);
      const refreshedRemote = yield* readRemoteStatus(cwd, { refreshUpstream: false });
      yield* updateCachedRemoteStatus(cwd, refreshedRemote, { publish: true });
      return yield* getStatusParts(cwd);
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Automatic project pull failed", {
            cwdLength: cwd.length,
            errorTag: error._tag,
          });
          if (!pullAttempted) return null;
          // A pull or its follow-up reads can fail after local state has changed.
          // Let a failed reconciliation reach the caller instead of publishing old status.
          yield* refreshLocalStatusCore(cwd);
          yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
          return yield* getStatusParts(cwd);
        }),
      ),
    );
  });

  const refreshRemoteStatus = Effect.fn("VcsStatusBroadcaster.refreshRemoteStatus")(function* (
    cwd: string,
    options?: {
      readonly refreshUpstream?: boolean;
      readonly policyCwds?: ReadonlyArray<string>;
    },
  ) {
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const remoteRead = yield* readRemoteStatus(cwd, options);
        const pulled =
          options?.refreshUpstream === false
            ? null
            : yield* maybeAutoPull(cwd, remoteRead, options?.policyCwds ?? [cwd]);
        if (pulled !== null) return pulled.remote;
        // Base refs and merge bases can move without changing divergence counts.
        yield* refreshLocalStatusCore(cwd);
        return yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
      }),
    );
  });

  const refreshRemoteAndLocalTotals = Effect.fn("VcsStatusBroadcaster.refreshRemoteAndLocalTotals")(
    function* (cwd: string, policyCwd: string) {
      return yield* withRemoteWriteLock(
        cwd,
        Effect.gen(function* () {
          const refreshUpstream = !Duration.isZero(yield* automaticFetchInterval);
          // Bump the PR lookup epoch after earlier remote writers have finished.
          yield* workflow.invalidateStatus(cwd);
          const remoteRead = yield* readRemoteStatus(cwd, { refreshUpstream });
          // Fetch can move the base used for local Changes totals.
          yield* refreshLocalStatusCore(cwd);
          // Without a fetch, the cached behind count cannot justify an automatic pull.
          const pulled = refreshUpstream
            ? yield* maybeAutoPull(cwd, remoteRead, [policyCwd])
            : null;
          if (pulled !== null) return mergeGitStatusParts(pulled.local, pulled.remote);
          yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
          const parts = yield* getStatusParts(cwd);
          return mergeGitStatusParts(parts.local, parts.remote);
        }),
      );
    },
  );

  const runStatusRefresh: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshStatus",
  )(function* (rawCwd, options) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    yield* refreshLocalStatusCore(cwd);
    if (options?.localOnly) {
      // Never cache a remote here: readers take `value: null` as "read and found no PR".
      const parts = yield* getStatusParts(cwd);
      return mergeGitStatusParts(parts.local, parts.remote);
    }
    return yield* refreshRemoteAndLocalTotals(cwd, rawCwd);
  });

  const refreshAfterCheckout: VcsStatusBroadcaster["Service"]["refreshAfterCheckout"] = Effect.fn(
    "VcsStatusBroadcaster.refreshAfterCheckout",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    const localDone = yield* Deferred.make<void>();
    // Owned by the broadcaster so a client disconnecting mid-switch still leaves status correct.
    yield* refreshLocalStatusCore(cwd).pipe(
      Effect.ensuring(Deferred.succeed(localDone, undefined)),
      Effect.andThen(refreshRemoteAndLocalTotals(cwd, rawCwd)),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(broadcasterScope),
    );
    yield* Deferred.await(localDone);
  });

  type RefreshReply = Deferred.Deferred<VcsStatusResult, GitManagerServiceError>;
  interface QueuedRefresh {
    current: RefreshReply;
    followUp: RefreshReply | null;
  }
  // Raw paths can select different auto-pull policies.
  const queuedRefreshes = new Map<string, QueuedRefresh>();
  const drainStatusRefreshes = Effect.fn("VcsStatusBroadcaster.drainStatusRefreshes")(function* (
    rawCwd: string,
    queue: QueuedRefresh,
  ) {
    while (true) {
      const result = yield* runStatusRefresh(rawCwd).pipe(Effect.exit);
      if (Exit.isFailure(result) && Exit.hasInterrupts(result)) {
        return yield* Effect.failCause(result.cause);
      }
      const { current, followUp } = queue;
      if (followUp === null) queuedRefreshes.delete(rawCwd);
      else {
        queue.current = followUp;
        queue.followUp = null;
      }
      Deferred.doneUnsafe(current, result);
      if (followUp === null) return;
    }
  });

  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = (rawCwd, options) => {
    if (options?.localOnly) return runStatusRefresh(rawCwd, options);
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (broadcasterScope.state._tag === "Closed") return yield* restore(Effect.interrupt);
        const requested = yield* Deferred.make<VcsStatusResult, GitManagerServiceError>();
        const queued = queuedRefreshes.get(rawCwd);
        if (queued) {
          queued.followUp ??= requested;
          return yield* restore(Deferred.await(queued.followUp));
        }
        if (queuedRefreshes.size >= MAX_STATUS_REFRESH_WORKERS) {
          return yield* new GitManagerError({
            operation: "VcsStatusBroadcaster.refreshStatus",
            cwd: rawCwd,
            detail: "Too many Git status refreshes are running. Try again shortly.",
          });
        }
        const queue: QueuedRefresh = { current: requested, followUp: null };
        queuedRefreshes.set(rawCwd, queue);
        // The worker belongs to the broadcaster so a caller can cancel its own wait.
        const worker = yield* drainStatusRefreshes(rawCwd, queue).pipe(
          Effect.forkIn(broadcasterScope, { startImmediately: true, uninterruptible: false }),
        );
        // A closed scope can interrupt the fork before its body or finalizers run.
        worker.addObserver((exit) => {
          if (queuedRefreshes.get(rawCwd) !== queue) return;
          queuedRefreshes.delete(rawCwd);
          const failure = Exit.isFailure(exit)
            ? Exit.failCause(exit.cause)
            : Exit.die(new Error("VCS refresh worker stopped with pending replies"));
          Deferred.doneUnsafe(queue.current, failure);
          if (queue.followUp) Deferred.doneUnsafe(queue.followUp, failure);
        });
        return yield* restore(Deferred.await(requested));
      }),
    );
  };

  const refreshPullRequestStatus: VcsStatusBroadcaster["Service"]["refreshPullRequestStatus"] =
    Effect.fn("VcsStatusBroadcaster.refreshPullRequestStatus")(function* (rawCwd) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      return yield* withRemoteWriteLock(
        cwd,
        Effect.gen(function* () {
          const cached = yield* getCachedStatus(cwd);
          if (!cached || cached.remote?.value === null) return null;
          // Turn completion must update divergence even when background polling is paused.
          const remoteRead = yield* readRemoteStatus(cwd, {
            refreshUpstream: false,
            refreshMissingPullRequest: true,
          });
          return yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
        }),
      );
    });

  // A subscription owns this loop; keep each poll's spans out of a never-ending parent span.
  const makeRemoteRefreshLoop = Effect.fnUntraced(function* (
    cwd: string,
    demandCwdsRef: Ref.Ref<ReadonlyMap<string, number>>,
    refreshImmediately: boolean,
  ) {
    const consecutiveFailuresRef = yield* Ref.make(0);
    const needsInitialRefreshRef = yield* Ref.make(refreshImmediately);
    const refreshRemoteStatusIfEnabled = Effect.gen(function* () {
      const configuredInterval = yield* automaticFetchInterval;
      const activeInterval = Duration.isZero(configuredInterval)
        ? DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL
        : configuredInterval;
      const needsInitialRefresh = yield* Ref.get(needsInitialRefreshRef);
      if (Duration.isZero(configuredInterval) && !needsInitialRefresh) {
        return activeInterval;
      }

      const demandCwds = yield* Ref.get(demandCwdsRef);
      const shouldRun =
        needsInitialRefresh ||
        (yield* Effect.forEach(
          [...demandCwds.keys()],
          (demandCwd) =>
            backgroundPolicy.shouldRunScopeWork({
              type: "vcs-status",
              cwd: demandCwd,
            }),
          { concurrency: "unbounded" },
        )).some(Boolean);
      if (!shouldRun) {
        return activeInterval;
      }

      const exit = yield* refreshRemoteStatus(cwd, {
        refreshUpstream: !Duration.isZero(configuredInterval),
        policyCwds: [...demandCwds.keys()],
      }).pipe(Effect.exit);
      if (Exit.isSuccess(exit)) {
        yield* Ref.set(needsInitialRefreshRef, false);
        yield* Ref.set(consecutiveFailuresRef, 0);
        return activeInterval;
      }

      const interruptionReasons = exit.cause.reasons.filter(Cause.isInterruptReason);
      if (interruptionReasons.length > 0) {
        return yield* Effect.failCause(Cause.fromReasons<never>(interruptionReasons));
      }

      const consecutiveFailures = yield* Ref.updateAndGet(
        consecutiveFailuresRef,
        (count) => count + 1,
      );
      const nextDelay = remoteRefreshFailureDelay(consecutiveFailures, activeInterval);
      yield* Effect.logWarning("VCS remote status refresh failed", {
        cwdLength: cwd.length,
        ...remoteRefreshFailureDiagnostics(exit.cause),
        consecutiveFailures,
        nextDelayMs: Duration.toMillis(nextDelay),
      });
      return nextDelay;
    });

    if (!refreshImmediately) {
      const configuredInterval = yield* automaticFetchInterval;
      yield* Effect.sleep(
        Duration.isZero(configuredInterval)
          ? DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL
          : configuredInterval,
      );
    }

    return yield* refreshRemoteStatusIfEnabled.pipe(
      Effect.repeat(
        Schedule.identity<Duration.Duration>().pipe(
          Schedule.addDelay(({ output: delay }) => Effect.succeed(delay)),
        ),
      ),
      Effect.asVoid,
    );
  });

  const retainRemotePoller = Effect.fn("VcsStatusBroadcaster.retainRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
    refreshImmediately: boolean,
  ) {
    yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (existing) {
        return Ref.update(existing.demandCwds, (demandCwds) => {
          const next = new Map(demandCwds);
          next.set(demandCwd, (next.get(demandCwd) ?? 0) + 1);
          return next;
        }).pipe(
          Effect.map(() => {
            const nextPollers = new Map(activePollers);
            nextPollers.set(cwd, {
              ...existing,
              subscriberCount: existing.subscriberCount + 1,
            });
            return [undefined, nextPollers] as const;
          }),
        );
      }

      return Ref.make<ReadonlyMap<string, number>>(new Map([[demandCwd, 1]])).pipe(
        Effect.flatMap((demandCwds) =>
          makeRemoteRefreshLoop(cwd, demandCwds, refreshImmediately).pipe(
            Effect.forkIn(broadcasterScope),
            Effect.map((fiber) => {
              const nextPollers = new Map(activePollers);
              nextPollers.set(cwd, {
                fiber,
                subscriberCount: 1,
                demandCwds,
              });
              return [undefined, nextPollers] as const;
            }),
          ),
        ),
      );
    });
  });

  const releaseRemotePoller = Effect.fn("VcsStatusBroadcaster.releaseRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
  ) {
    const pollerToInterrupt = yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (!existing) {
        return Effect.succeed([null, activePollers] as const);
      }

      if (existing.subscriberCount > 1) {
        return Ref.update(existing.demandCwds, (demandCwds) => {
          const nextDemandCwds = new Map(demandCwds);
          const count = nextDemandCwds.get(demandCwd) ?? 0;
          if (count <= 1) {
            nextDemandCwds.delete(demandCwd);
          } else {
            nextDemandCwds.set(demandCwd, count - 1);
          }
          return nextDemandCwds;
        }).pipe(
          Effect.as([
            null,
            new Map(activePollers).set(cwd, {
              ...existing,
              subscriberCount: existing.subscriberCount - 1,
            }),
          ] as const),
        );
      }

      return Effect.succeed([
        existing.fiber,
        new Map([...activePollers].filter(([activeCwd]) => activeCwd !== cwd)),
      ] as const);
    });

    if (pollerToInterrupt) {
      yield* Fiber.interrupt(pollerToInterrupt).pipe(Effect.ignore);
    }
  });

  const readHeadBranch = Effect.fn("VcsStatusBroadcaster.readHeadBranch")(function* (cwd: string) {
    const observation = ++branchObservation;
    const refName = yield* workflow.currentBranch(cwd);
    const isRepo = refName !== null || (yield* workflow.repositoryRoot(cwd)) !== null;
    const head = { observation, refName, isRepo };
    const previous = headDuringLocalRead.get(cwd);
    if (previous !== undefined && (previous === null || previous.observation < observation)) {
      headDuringLocalRead.set(cwd, head);
    }
    return head;
  });

  // Serialize cache invalidation with detailed reads and refreshes.
  const refreshBranchStatusCore = Effect.fn("VcsStatusBroadcaster.refreshBranchStatusCore")(
    (cwd: string) =>
      localRefreshLocks.withLock(
        cwd,
        Effect.gen(function* () {
          const { refName, isRepo, observation } = yield* readHeadBranch(cwd);
          const cached = yield* getCachedStatus(cwd);
          if (
            detailedSubscribers.has(cwd) &&
            cached?.local?.value.refName === refName &&
            cached.local.value.isRepo === isRepo
          ) {
            yield* publishBranch(cwd, { refName, isRepo }, observation);
            return branchUpdates.latest(cwd) ?? { refName, isRepo, revision: 0 };
          }
          // HEAD cannot certify working-tree totals, even when it has not moved.
          localRefreshResults.delete(cwd);
          yield* workflow.invalidateLocalStatus(cwd);
          const previous = cache.get(cwd);
          if (previous) cache.set(cwd, { ...previous, local: null });
          if (detailedSubscribers.has(cwd)) {
            const local = yield* loadLocalStatus(cwd, { publish: true });
            return (
              branchUpdates.latest(cwd) ?? {
                refName: local.refName,
                isRepo: local.isRepo,
                revision: 0,
              }
            );
          }
          yield* publishBranch(cwd, { refName, isRepo }, observation);
          return branchUpdates.latest(cwd) ?? { refName, isRepo, revision: 0 };
        }),
      ),
  );

  const publishCheckedOutRef = Effect.fn("VcsStatusBroadcaster.publishCheckedOutRef")(function* (
    cwd: string,
  ) {
    if (!detailedSubscribers.has(cwd)) {
      yield* refreshBranchStatusCore(cwd);
      return;
    }
    const { observation, refName, isRepo } = yield* readHeadBranch(cwd);
    yield* publishBranch(cwd, { refName, isRepo }, observation);
  });

  const reconcileCheckedOutRef = Effect.fn("VcsStatusBroadcaster.reconcileCheckedOutRef")(
    function* (cwd: string) {
      if (!detailedSubscribers.has(cwd)) return;
      if ((yield* getCachedStatus(cwd))?.remote) {
        yield* refreshRemoteStatus(cwd, { refreshUpstream: false });
      } else {
        yield* refreshLocalStatusCore(cwd);
      }
    },
  );

  const watchCheckout = yield* makeHeadWatchers(
    broadcasterScope,
    workflow.headPath,
    publishCheckedOutRef,
    reconcileCheckedOutRef,
  );

  const streamStatus: VcsStatusBroadcaster["Service"]["streamStatus"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = detailedSubscribers.get(cwd) ?? 0;
            detailedSubscribers.set(cwd, previous + 1);
          }),
          () =>
            Effect.sync(() => {
              const remaining = (detailedSubscribers.get(cwd) ?? 1) - 1;
              if (remaining === 0) detailedSubscribers.delete(cwd);
              else detailedSubscribers.set(cwd, remaining);
            }),
        );
        const subscription = yield* PubSub.subscribe(changesPubSub);
        yield* watchCheckout(cwd);
        const initialLocal = yield* getOrLoadLocalStatus(cwd, true);
        const cachedStatus = yield* getCachedStatus(cwd);
        const cachedRemote = cachedStatus?.remote;
        const initialRemote =
          initialLocal.isRepo && cachedRemote && cachedRemote.branch === initialLocal.refName
            ? cachedRemote.value
            : null;
        if (input.includeRemote !== false) {
          yield* retainRemotePoller(
            cwd,
            input.cwd,
            cachedStatus?.remote === null || cachedStatus?.remote === undefined,
          );
        }
        const release =
          input.includeRemote === false
            ? Effect.void
            : releaseRemotePoller(cwd, input.cwd).pipe(Effect.ignore, Effect.asVoid);

        return Stream.concat(
          Stream.make({
            _tag: "snapshot" as const,
            local: initialLocal,
            remote: initialRemote,
          }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.cwd === cwd),
            Stream.map((change) => change.events),
            Stream.flattenArray,
          ),
        ).pipe(Stream.ensuring(release));
      }),
    );

  // Each checkout has at most one worker and one pending detailed reconciliation.
  const branchReconciliations = new Map<string, boolean>();
  const requestBranchReconciliation = Effect.fn("VcsStatusBroadcaster.requestBranchReconciliation")(
    function* (cwd: string) {
      if (branchReconciliations.has(cwd)) {
        branchReconciliations.set(cwd, true);
        return;
      }
      branchReconciliations.set(cwd, true);
      yield* Effect.whileLoop({
        while: () => {
          if (branchReconciliations.get(cwd) === true) return true;
          branchReconciliations.delete(cwd);
          return false;
        },
        body: () => {
          branchReconciliations.set(cwd, false);
          return refreshBranchStatusCore(cwd).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("VCS branch refresh failed", {
                cwdLength: cwd.length,
                ...remoteRefreshFailureDiagnostics(cause),
              }),
            ),
          );
        },
        step: () => {},
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            branchReconciliations.delete(cwd);
          }),
        ),
        Effect.interruptible,
        Effect.forkIn(broadcasterScope),
        Effect.asVoid,
      );
    },
    Effect.uninterruptible,
  );

  const refreshBranchStatus: VcsStatusBroadcaster["Service"]["refreshBranchStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshBranchStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    if (!detailedSubscribers.has(cwd)) {
      const { refName, isRepo } = yield* refreshBranchStatusCore(cwd);
      return { refName, isRepo };
    }
    const { observation, refName, isRepo } = yield* readHeadBranch(cwd);
    yield* publishBranch(cwd, { refName, isRepo }, observation);
    yield* requestBranchReconciliation(cwd);
    return { refName, isRepo };
  });

  const streamBranchStatus: VcsStatusBroadcaster["Service"]["streamBranchStatus"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const subscription = yield* branchUpdates.subscribe(cwd);
        yield* watchCheckout(cwd);
        const { observation, refName, isRepo } = yield* readHeadBranch(cwd);
        yield* publishBranch(cwd, { refName, isRepo }, observation);
        const branch = branchUpdates.latest(cwd) ?? { refName, isRepo, revision: 0 };
        if (detailedSubscribers.has(cwd) || (yield* getCachedStatus(cwd))?.local) {
          yield* requestBranchReconciliation(cwd);
        }
        return Stream.concat(
          Stream.make({ refName: branch.refName, isRepo: branch.isRepo }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.revision > branch.revision),
            Stream.map(({ refName, isRepo }) => ({ refName, isRepo })),
          ),
        ).pipe(
          Stream.changesWith(
            (left, right) => left.refName === right.refName && left.isRepo === right.isRepo,
          ),
        );
      }),
    );

  return VcsStatusBroadcaster.of({
    streamBranchStatus,
    refreshBranchStatus,
    getStatus,
    refreshLocalStatus,
    refreshAfterCheckout,
    refreshStatus,
    refreshPullRequestStatus,
    streamStatus,
  });
});

export const layer = Layer.effect(VcsStatusBroadcaster, make);
