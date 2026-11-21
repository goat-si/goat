import * as AutomationHold from "../automationHold.ts";
import {
  CommandId,
  type OrchestrationV2Notification,
  type PullRequestActivity,
  type PullRequestComment,
  type PullRequestRef,
  type PullRequestThreadCommentsResult,
  type ThreadPullRequestLink,
  type ThreadPullRequestWatch,
} from "@goat/contracts";
import { visibleThreadPullRequests } from "@goat/shared/threadPullRequests";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "../sourceControl/threadPullRequests.ts";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  type ProviderChangeRequestWatchFingerprint,
  PullRequestProviderError,
} from "@goat/source-control-core/server/PullRequestProvider";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  evaluatePullRequestWatch,
  PULL_REQUEST_WATCH_NO_CHECKS_MS,
  pullRequestWatchOutcome,
  type PullRequestWatchWake,
} from "./pullRequestWatch.ts";
import { pullRequestWakeMessageId } from "./goat/PullRequestWatchWakes.ts";
import { EVENT_SETTLE, feedsToFollow } from "./goat/PullRequestEventFeeds.ts";
import { makeWatchSweepCursor, watchSweepPage } from "./goat/PullRequestWatchPage.ts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

/** Checks take minutes; faster sweeps waste the account's shared host quota. */
const SWEEP_MINUTES = 2;
const READ_FAILURE_LIMIT = 8;
/** A failed read waits twice as long as the one before it, up to this, before the next try. */
const READ_RETRY_MAX_MS = 30 * 60_000;
/** Without fingerprints, reread quiet PRs on snapshot changes or this interval to catch edits. */
const QUIET_REREAD_MS = 10 * 60_000;
/** Reread despite unchanged fingerprints; they miss review-thread comment edits. */
const FINGERPRINT_REREAD_MS = 30 * 60_000;

const isProviderError = Schema.is(PullRequestProviderError);

const providerFailureReason = (cause: Cause.Cause<PullRequestService.PullRequestError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => null,
    onSome: (error) =>
      error._tag === "PullRequestOperationError" && isProviderError(error.cause)
        ? error.cause.reason
        : null,
  });

const logFailure =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause });

interface WatchTarget {
  readonly thread: ProjectionStore.ProjectionThreadPullRequests;
  readonly link: ThreadPullRequestLink;
  readonly watch: ThreadPullRequestWatch;
}

/** A wake a pass holds back so each thread wakes once for everything the pass found. */
interface HeldWake {
  readonly groupKey: string;
  readonly target: WatchTarget;
  readonly next: ThreadPullRequestWatch | null;
  readonly wake: PullRequestWatchWake;
  readonly endedWatch?: ThreadPullRequestWatch | undefined;
  readonly dropQueuedWakes?: true;
  /** Bookkeeping that follows a sent wake. */
  readonly after: Effect.Effect<void>;
}

interface WatchGroup {
  readonly key: string;
  readonly targets: readonly [WatchTarget, ...Array<WatchTarget>];
}

interface LastRead {
  readonly at: number;
  readonly fingerprint: string;
  readonly inFlight: boolean;
  readonly remarksComplete: boolean;
  readonly status: string | null;
  readonly remarks: string | null;
}

interface ReadPlan {
  readonly detail: boolean;
  readonly activity: boolean;
}

type WatchEndReason =
  | "merged"
  | "closed"
  | "unreadable"
  | "comment-limit"
  | "settled"
  | "subagent"
  | "stopped";

interface WatchLife {
  readonly threadId: string;
  readonly pullRequest: string;
  readonly startedAt: number;
  readonly headSha: string | null;
  readonly pushedAt: number;
  readonly longestQuietMs: number;
  readonly wakes: number;
  readonly reads: number;
}

const lifeKeyOf = (threadId: string, link: ThreadPullRequestLink, watch: ThreadPullRequestWatch) =>
  `${threadPullRequestKeyOf(link)} ${threadId} ${watch.startedAt}`;
const lifeKey = ({ thread, link, watch }: WatchTarget) => lifeKeyOf(thread.id, link, watch);

// Checkout access differs by project.
const groupKeyOf = ({ thread, link }: WatchTarget) =>
  `${thread.projectId} ${threadPullRequestKeyOf(link)}`;

const readKey = (target: WatchTarget) => `${target.thread.projectId} ${lifeKey(target)}`;

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

const snapshotFingerprint = ({ link }: WatchTarget) => {
  const snapshot = link.snapshot;
  return snapshot === null
    ? ""
    : [
        snapshot.state,
        snapshot.updatedAt,
        snapshot.checksState,
        snapshot.mergeability,
        snapshot.rebaseRequired,
        snapshot.reviewDecision,
        snapshot.isDraft,
      ].join(" ");
};

function planRead(
  watch: ThreadPullRequestWatch,
  last: LastRead | undefined,
  fingerprint: ProviderChangeRequestWatchFingerprint | null,
  snapshot: string,
  now: number,
): ReadPlan {
  if (last === undefined) return { detail: true, activity: true };
  // Nothing on the host changes when the no-checks deadline passes, or when a push to another
  // branch clears a watch's answer, so either alone prompts a read.
  const checksDue =
    watch.checksPending === undefined ||
    (watch.checksAwaitedSince != null &&
      now - Date.parse(watch.checksAwaitedSince) >= PULL_REQUEST_WATCH_NO_CHECKS_MS);
  if (fingerprint === null) {
    const read =
      last.inFlight ||
      !last.remarksComplete ||
      last.fingerprint !== snapshot ||
      now - last.at >= QUIET_REREAD_MS;
    return { detail: read || checksDue, activity: read };
  }
  const activity =
    last.remarks !== fingerprint.remarks ||
    !last.remarksComplete ||
    now - last.at >= FINGERPRINT_REREAD_MS;
  return {
    detail:
      activity ||
      checksDue ||
      last.status !== fingerprint.status ||
      (last.inFlight && fingerprint.coversDetail !== true),
    activity,
  };
}

// Lets the orchestrator tell that a push cleared the answer while this read was in flight.
const checksPendingBeforeOf = ({ watch }: WatchTarget) =>
  watch.checksPending === undefined ? {} : { checksPendingBefore: watch.checksPending };

function watchesEqual(left: ThreadPullRequestWatch, right: ThreadPullRequestWatch): boolean {
  return (
    left.startedAt === right.startedAt &&
    left.headSha === right.headSha &&
    left.failedChecks.join("\n") === right.failedChecks.join("\n") &&
    left.passed === right.passed &&
    left.passedChecks.join("\n") === right.passedChecks.join("\n") &&
    (left.owedChecks ?? []).join("\n") === (right.owedChecks ?? []).join("\n") &&
    (left.awaitingApproval ?? []).join("\n") === (right.awaitingApproval ?? []).join("\n") &&
    (left.approvalAnnounced ?? false) === (right.approvalAnnounced ?? false) &&
    left.remarksThrough === right.remarksThrough &&
    left.remarkIds.join("\n") === right.remarkIds.join("\n") &&
    left.conflicting === right.conflicting &&
    left.rebaseRequired === right.rebaseRequired &&
    left.mergeQueueRemovalId === right.mergeQueueRemovalId &&
    left.wakes === right.wakes &&
    left.awaitingBaseline === right.awaitingBaseline &&
    left.checksAwaitedSince === right.checksAwaitedSince &&
    left.checksPending === right.checksPending &&
    // Kept context is merged by the orchestrator; a pass sends only what it kept itself.
    left.automatic === right.automatic
  );
}

export class PullRequestWatchReactor extends Context.Service<
  PullRequestWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly sweep: Effect.Effect<void>;
  }
>()("goat/orchestration-v2/PullRequestWatchReactor") {}

/** @public */
export const make = Effect.gen(function* () {
  const hold = yield* AutomationHold.AutomationHold;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const bootedAt = yield* Clock.currentTimeMillis;
  const lives = new Map<string, WatchLife>();

  const lifeOf = (target: WatchTarget): WatchLife => {
    const existing = lives.get(lifeKey(target));
    if (existing !== undefined) return existing;
    const startedAt = Date.parse(target.watch.startedAt);
    const life: WatchLife = {
      threadId: target.thread.id,
      pullRequest: threadPullRequestKeyOf(target.link),
      startedAt,
      headSha: target.watch.headSha,
      pushedAt: startedAt,
      longestQuietMs: 0,
      wakes: 0,
      reads: 0,
    };
    lives.set(lifeKey(target), life);
    return life;
  };
  const woke = (target: WatchTarget) =>
    Effect.sync(() => {
      const life = lifeOf(target);
      lives.set(lifeKey(target), { ...life, wakes: life.wakes + 1 });
    });

  const reportEnd = Effect.fn("PullRequestWatchReactor.reportEnd")(function* (
    key: string,
    life: WatchLife,
    reason: WatchEndReason,
  ) {
    lives.delete(key);
    const now = yield* Clock.currentTimeMillis;
    const quietMs = now - life.pushedAt;
    yield* Effect.logInfo("pull request watch ended", {
      threadId: life.threadId,
      pullRequest: life.pullRequest,
      reason,
      minutes: minutes(now - life.startedAt),
      quietMinutes: minutes(quietMs),
      longestQuietMinutes: minutes(Math.max(life.longestQuietMs, quietMs)),
      wakes: life.wakes,
      reads: life.reads,
      partial: life.startedAt < bootedAt,
    });
  });
  const ended = (target: WatchTarget, reason: WatchEndReason) =>
    Effect.suspend(() => reportEnd(lifeKey(target), lifeOf(target), reason));

  /** Consecutive failed reads by watch and pull request, so each watch has its own limit. */
  const readFailures = new Map<string, number>();
  const readRetryAt = new Map<string, number>();
  let feedCandidates: ReadonlyArray<readonly [string, PullRequestRef]> = [];
  const sweepCursor = yield* makeWatchSweepCursor;
  // A pass reads watches and records new ones, so passes must not overlap.
  const passes = Semaphore.makeUnsafe(1);
  const lastReads = new Map<string, LastRead>();
  const threadTails = new Map<
    string,
    {
      readonly fetchedAt: number;
      readonly visibleThrough: number;
      readonly tails: ReadonlyMap<
        string,
        { readonly count: number; readonly comments: ReadonlyArray<PullRequestComment> }
      >;
    }
  >();

  const identityOf = (link: ThreadPullRequestLink) => ({
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
  });

  /**
   * The orchestrator applies this only while the same watch is on, so a stop or restart
   * that lands during the host read wins.
   */
  const record = Effect.fn("PullRequestWatchReactor.record")(function* (
    target: WatchTarget,
    next: ThreadPullRequestWatch | null,
    wake?: PullRequestWatchWake,
    note?: OrchestrationV2Notification,
    endedWatch?: ThreadPullRequestWatch,
    dropQueuedWakes?: true,
  ) {
    const uuid = yield* random.uuidV4();
    yield* engine.dispatch({
      type: "thread.pull-request-watch.sync",
      commandId: CommandId.make(`server:pr-watch:${target.thread.id}:${uuid}`),
      threadId: target.thread.id,
      ...identityOf(target.link),
      startedAt: target.watch.startedAt,
      watch: next,
      ...checksPendingBeforeOf(target),
      ...(endedWatch === undefined ? {} : { endedWatch }),
      ...(wake === undefined
        ? {}
        : {
            wake: {
              text: wake.text,
              notification: wake.notification,
              messageId: pullRequestWakeMessageId(target.link, uuid, wake.checksOn, next === null),
            },
          }),
      ...(note === undefined ? {} : { note }),
      ...(dropQueuedWakes === undefined ? {} : { dropQueuedWakes }),
    });
  });

  const giveUp = (target: WatchTarget) =>
    record(target, null, {
      text: `GOAT stopped watching pull request #${target.link.number} (${target.link.url}) because it failed to read it from the host ${READ_FAILURE_LIMIT} times in a row. Check it yourself, and call ${goatCallText("pull_request.watch")} only if it is still open.`,
      notification: {
        source: { kind: "monitor" },
        outcome: "failed",
        summary: `#${target.link.number}: stopped watching, could not read it`,
      },
    }).pipe(
      Effect.tap(() => woke(target)),
      Effect.catch(() => record(target, null)),
      Effect.tap(() => ended(target, "unreadable")),
    );

  const readRemarks = Effect.fn("PullRequestWatchReactor.readRemarks")(
    function* (
      key: string,
      reference: PullRequestRef,
      activity: PullRequestActivity,
      now: number,
      rereadMs: number,
    ) {
      // Comment cursors cannot account for missing threads. Only finish a truncated read
      // when the host confirms that every thread was listed.
      if (activity.commentsTruncated && activity.reviewThreadsTruncated !== false) return null;

      const visibleThrough = activity.comments.reduce(
        (latest, comment) => Math.max(latest, Date.parse(comment.editedAt ?? comment.createdAt)),
        0,
      );
      const paginated = activity.reviewThreads.filter(
        (thread) => thread.nextCommentsCursor != null,
      );
      const cached = threadTails.get(key);
      // All tails share one watermark, so newer visible remarks or a changed thread must
      // refresh the entire group before any remarks can advance it.
      const reuse =
        cached !== undefined &&
        now - cached.fetchedAt < rereadMs &&
        cached.visibleThrough === visibleThrough &&
        cached.tails.size === paginated.length &&
        paginated.every(
          (thread) => cached.tails.get(thread.id)?.count === (thread.commentCount ?? 0),
        );
      const tails = new Map<
        string,
        { count: number; comments: ReadonlyArray<PullRequestComment> }
      >();
      const remarks = [...activity.comments];
      for (const thread of paginated) {
        let cursor = thread.nextCommentsCursor ?? null;
        const count = thread.commentCount ?? 0;
        let tail = reuse ? cached.tails.get(thread.id) : undefined;
        if (tail === undefined) {
          const comments = new Map<string, PullRequestComment>();
          const cursors = new Set<string>();
          let hidden = 0;
          while (cursor !== null) {
            if (cursors.has(cursor)) return null;
            cursors.add(cursor);
            const page: PullRequestThreadCommentsResult = yield* pullRequests.threadComments({
              ...reference,
              threadId: thread.id,
              cursor,
            });
            for (const comment of page.comments) {
              comments.set(comment.id, {
                ...comment,
                kind: "review-comment",
                path: thread.path,
                reviewState: null,
              });
            }
            hidden += page.hiddenCount ?? 0;
            cursor = page.nextCursor;
          }
          if (thread.comments.length + comments.size + hidden < count) return null;
          tail = { count, comments: [...comments.values()] };
        }
        tails.set(thread.id, tail);
        remarks.push(...tail.comments);
      }
      threadTails.set(key, {
        fetchedAt: reuse ? cached.fetchedAt : now,
        visibleThrough,
        tails,
      });
      return remarks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    Effect.catch((error) =>
      Effect.logWarning("pull request watch comment pagination failed", { error }).pipe(
        Effect.as(null),
      ),
    ),
    (effect, key) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            // A retry must refresh every tail before advancing the shared remark watermark.
            if (Exit.isFailure(exit) || exit.value === null) threadTails.delete(key);
          }),
        ),
      ),
  );

  const sendOne = (item: HeldWake) =>
    record(
      item.target,
      item.next,
      item.wake,
      undefined,
      item.endedWatch,
      item.dropQueuedWakes,
    ).pipe(
      Effect.andThen(item.after),
      Effect.catchCause((cause) => {
        lastReads.delete(readKey(item.target));
        return logFailure("pull request watch update failed", {
          threadId: item.target.thread.id,
          pullRequest: item.groupKey,
        })(cause);
      }),
    );

  const sendTogether = Effect.fn("PullRequestWatchReactor.sendTogether")(function* (
    items: readonly [HeldWake, ...ReadonlyArray<HeldWake>],
  ) {
    const [first, ...rest] = items;
    const uuid = yield* random.uuidV4();
    const entry = (item: HeldWake, index: number) => ({
      ...identityOf(item.target.link),
      startedAt: item.target.watch.startedAt,
      watch: item.next,
      ...checksPendingBeforeOf(item.target),
      ...(item.endedWatch === undefined ? {} : { endedWatch: item.endedWatch }),
      ...(item.dropQueuedWakes === undefined ? {} : { dropQueuedWakes: item.dropQueuedWakes }),
      wake: {
        text: item.wake.text,
        notification: item.wake.notification,
        messageId: pullRequestWakeMessageId(
          item.target.link,
          `${uuid}-${index}`,
          item.wake.checksOn,
          item.next === null,
        ),
      },
    });
    yield* engine.dispatch({
      type: "thread.pull-request-watch.sync",
      commandId: CommandId.make(`server:pr-watch:${first.target.thread.id}:${uuid}`),
      threadId: first.target.thread.id,
      ...entry(first, 0),
      others: rest.map((item, index) => entry(item, index + 1)),
    });
    yield* Effect.forEach(items, (item) => item.after, { discard: true });
  });

  /** One wake per thread for the pass; a refused batch sends each on its own, as a watch that ended decides alone. */
  const sendHeld = (items: ReadonlyArray<HeldWake>) => {
    const byThread = new Map<string, [HeldWake, ...Array<HeldWake>]>();
    for (const item of items) {
      const threadId = item.target.thread.id;
      const batch = byThread.get(threadId);
      if (batch === undefined) byThread.set(threadId, [item]);
      else batch.push(item);
    }
    return Effect.forEach(
      byThread.values(),
      (batch) =>
        batch.length === 1
          ? sendOne(batch[0])
          : sendTogether(batch).pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                () => Effect.forEach(batch, sendOne, { discard: true }),
              ),
            ),
      { discard: true },
    );
  };

  const closed = (
    groupKey: string,
    target: WatchTarget,
    holdWake: (item: HeldWake) => Effect.Effect<void>,
  ) =>
    holdWake({
      groupKey,
      target,
      next: null,
      wake: {
        text: `Pull request #${target.link.number} (${target.link.url}) was closed, so GOAT stopped watching it. Call ${goatCallText("pull_request.watch")} if it reopens.`,
        notification: {
          source: { kind: "monitor" },
          outcome: "updated",
          summary: `#${target.link.number}: closed, stopped watching`,
        },
      },
      dropQueuedWakes: true,
      after: woke(target).pipe(Effect.andThen(ended(target, "closed"))),
    });

  const endsWithoutRead = ({ thread, link }: WatchTarget): WatchEndReason | undefined =>
    link.snapshot?.state === "merged"
      ? "merged"
      : thread.settledOverride === "settled" || thread.settledAt !== null
        ? "settled"
        : thread.lineage.relationshipToParent === "subagent"
          ? "subagent"
          : undefined;

  const eachTarget = <E>(
    key: string,
    targets: ReadonlyArray<WatchTarget>,
    step: (target: WatchTarget) => Effect.Effect<void, E>,
  ) =>
    Effect.forEach(targets, (target) =>
      step(target).pipe(
        Effect.as(true),
        Effect.catchCause((cause) => {
          lastReads.delete(readKey(target));
          return logFailure("pull request watch update failed", {
            threadId: target.thread.id,
            pullRequest: key,
          })(cause).pipe(Effect.as(false));
        }),
      ),
    ).pipe(Effect.map((landed) => landed.every(Boolean)));

  const referenceOf = ({ thread, link }: WatchTarget) => ({
    projectId: thread.projectId,
    ...identityOf(link),
  });

  const fingerprintOf = (group: WatchGroup) =>
    pullRequests.watchFingerprint(referenceOf(group.targets[0])).pipe(
      Effect.catchCause(
        (cause): Effect.Effect<ProviderChangeRequestWatchFingerprint | null | "paused"> =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : providerFailureReason(cause) === "rate-limited"
              ? Effect.succeed("paused")
              : Effect.logDebug("pull request watch fingerprint failed", {
                  pullRequest: group.key,
                  cause,
                }).pipe(Effect.as(null)),
      ),
    );

  const readGroup = Effect.fn("PullRequestWatchReactor.readGroup")(function* (
    group: WatchGroup,
    fingerprint: ProviderChangeRequestWatchFingerprint | null,
    holdWake: (item: HeldWake) => Effect.Effect<void>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const reads = group.targets.map((target) => {
      const key = readKey(target);
      const last = lastReads.get(key);
      const snapshot = snapshotFingerprint(target);
      return {
        key,
        target,
        last,
        snapshot,
        plan: planRead(target.watch, last, fingerprint, snapshot, now),
      };
    });
    if (!reads.some(({ plan }) => plan.detail)) return;
    const readActivity = reads.some(({ plan }) => plan.activity);
    // Read before anything is recorded: a failed read must leave the pass to run again.
    // Groups are per project, so one policy covers every thread in the group.
    const policy = resolveProjectSettings(
      yield* settingsService.getSettings,
      group.targets[0].thread.projectId,
    ).settings.pullRequestWatchPolicy;
    if (
      reads.some(
        ({ last }) =>
          last === undefined || (fingerprint !== null && last.remarks !== fingerprint.remarks),
      )
    ) {
      // A new watch or changed host remarks needs a fresh view of every tail.
      threadTails.delete(group.key);
    }
    const reference = referenceOf(group.targets[0]);
    // Invalidate cached reads before using the newer fingerprint; clients receive no notification.
    if (fingerprint !== null) yield* pullRequests.invalidate({ reference });
    const [detailRead, activityRead] = yield* Effect.all(
      [
        Effect.exit(pullRequests.detail({ ...reference, allowStale: false })),
        readActivity ? Effect.exit(pullRequests.activity(reference)) : Effect.succeed(null),
      ],
      { concurrency: 2 },
    );
    if (Exit.isFailure(detailRead)) {
      if (Cause.hasInterruptsOnly(detailRead.cause))
        return yield* Effect.failCause(detailRead.cause);
      for (const { key } of reads) lastReads.delete(key);
      const reason = providerFailureReason(detailRead.cause);
      if (reason === "rate-limited") return;
      if (reason === "failed") {
        for (const { key, target } of reads) {
          readFailures.delete(lifeKey(target));
          readRetryAt.set(key, now + SWEEP_MINUTES * 60_000);
        }
        return yield* Effect.failCause(detailRead.cause);
      }
      const counts = group.targets.map((target) => {
        const count = (readFailures.get(lifeKey(target)) ?? 0) + 1;
        readFailures.set(lifeKey(target), count);
        return { target, count };
      });
      // The newest watch sets the pace, so it is not held back by older watches' failures.
      const fewest = Math.min(...counts.map(({ count }) => count));
      const retryAt = now + Math.min(SWEEP_MINUTES * 60_000 * 2 ** (fewest - 1), READ_RETRY_MAX_MS);
      for (const { key } of reads) readRetryAt.set(key, retryAt);
      const spent = counts.flatMap(({ target, count }) =>
        count >= READ_FAILURE_LIMIT ? [target] : [],
      );
      if (spent.length > 0 && (yield* eachTarget(group.key, spent, giveUp))) {
        for (const target of spent) readFailures.delete(lifeKey(target));
      }
      return yield* Effect.failCause(detailRead.cause);
    }
    for (const { key, target } of reads) {
      readFailures.delete(lifeKey(target));
      readRetryAt.delete(key);
    }
    const detail = detailRead.value;
    if (activityRead !== null && Exit.isFailure(activityRead)) {
      if (Cause.hasInterruptsOnly(activityRead.cause))
        return yield* Effect.failCause(activityRead.cause);
      threadTails.delete(group.key);
      if (providerFailureReason(activityRead.cause) !== "rate-limited") {
        yield* logFailure("pull request watch activity read failed", { pullRequest: group.key })(
          activityRead.cause,
        );
      }
    }
    const activity =
      activityRead !== null && Exit.isSuccess(activityRead)
        ? Option.some(activityRead.value)
        : Option.none<PullRequestActivity>();
    for (const target of group.targets) {
      const life = lifeOf(target);
      const headSha = detail.headSha ?? life.headSha;
      const pushed = life.headSha !== null && headSha !== life.headSha;
      lives.set(lifeKey(target), {
        ...life,
        headSha,
        reads: life.reads + 1,
        ...(pushed
          ? { pushedAt: now, longestQuietMs: Math.max(life.longestQuietMs, now - life.pushedAt) }
          : {}),
      });
    }
    if (detail.state !== "open") {
      for (const { key } of reads) lastReads.delete(key);
      return yield* eachTarget(group.key, group.targets, (target) =>
        detail.state === "closed"
          ? closed(group.key, target, holdWake)
          : record(target, null, undefined, undefined, undefined, true).pipe(
              Effect.tap(() => ended(target, "merged")),
            ),
      );
    }

    // Never advance the remark watermark past comments an incomplete read could have missed.
    const remarks = Option.isSome(activity)
      ? yield* readRemarks(
          group.key,
          reference,
          activity.value,
          now,
          fingerprint === null ? QUIET_REREAD_MS : FINGERPRINT_REREAD_MS,
        )
      : null;
    const inFlight =
      detail.mergeability === "unknown" ||
      detail.checks.some(
        (check) => check.status === "pending" || check.status === "action-required",
      );
    const remarksAt = threadTails.get(group.key)?.fetchedAt ?? now;
    for (const { key, last, snapshot } of reads) {
      lastReads.set(key, {
        at: readActivity && remarks !== null ? remarksAt : (last?.at ?? now),
        fingerprint: snapshot,
        inFlight,
        remarksComplete: readActivity ? remarks !== null : (last?.remarksComplete ?? false),
        status: fingerprint?.status ?? null,
        remarks: fingerprint?.remarks ?? null,
      });
    }
    yield* eachTarget(group.key, group.targets, (target) => {
      const report = evaluatePullRequestWatch(target.watch, detail, remarks, {
        policy,
        threadActiveAt: DateTime.toEpochMillis(target.thread.updatedAt),
        now,
      });
      const outcome = pullRequestWatchOutcome({
        number: target.link.number,
        url: target.link.url,
        baseBranch: detail.baseBranch,
        report,
      });
      if (outcome.wake !== undefined) {
        return holdWake({
          groupKey: group.key,
          target,
          next: outcome.next,
          wake: outcome.wake,
          endedWatch: outcome.endedWatch,
          after: woke(target).pipe(
            Effect.andThen(report.exhausted ? ended(target, "comment-limit") : Effect.void),
          ),
        });
      }
      if (outcome.note !== undefined) return record(target, outcome.next, undefined, outcome.note);
      return outcome.next !== null && watchesEqual(outcome.next, target.watch)
        ? Effect.void
        : record(target, outcome.next);
    });
  });

  /** Every watch, or with `changed`, only that pull request's after its host reported a change. */
  // The sweep and change reads each name their own span.
  const pass = Effect.fnUntraced(function* (changed: string | undefined) {
    const held: Array<HeldWake> = [];
    const holdWake = (item: HeldWake) => Effect.sync(() => void held.push(item));
    const threads = yield* projections.getThreadsWithPullRequests();
    const targets = threads.flatMap((thread) =>
      visibleThreadPullRequests(thread.pullRequests ?? []).flatMap((link) =>
        link.watch === undefined ||
        (changed !== undefined && threadPullRequestKeyOf(link) !== changed)
          ? []
          : [{ thread, link, watch: link.watch }],
      ),
    );
    const present = new Set(targets.map(lifeKey));
    if (changed === undefined) {
      yield* Effect.forEach(
        [...lives].filter(([key]) => !present.has(key)),
        ([key, life]) => reportEnd(key, life, "stopped"),
        { discard: true },
      );
    }
    const work = targets.map((target) => ({
      key: lifeKey(target),
      groupKey: groupKeyOf(target),
      target,
      reason: endsWithoutRead(target),
    }));
    if (changed === undefined) {
      const feeds: Array<readonly [string, PullRequestRef]> = [];
      const activeGroups = new Set<string>();
      const activeReads = new Set<string>();
      for (const { groupKey, target, reason } of work) {
        if (reason !== undefined) continue;
        activeReads.add(readKey(target));
        if (activeGroups.has(groupKey)) continue;
        activeGroups.add(groupKey);
        feeds.push([threadPullRequestKeyOf(target.link), referenceOf(target)]);
      }
      feedCandidates = feeds;
      for (const key of threadTails.keys()) if (!activeGroups.has(key)) threadTails.delete(key);
      for (const cache of [readRetryAt, lastReads]) {
        for (const key of cache.keys()) if (!activeReads.has(key)) cache.delete(key);
      }
      for (const key of readFailures.keys()) if (!present.has(key)) readFailures.delete(key);
    }
    const page = watchSweepPage(work, changed === undefined ? sweepCursor.after : undefined);
    const groups = new Map<string, [WatchTarget, ...Array<WatchTarget>]>();
    yield* Effect.forEach(
      page.items,
      ({ target, reason, groupKey }) => {
        if (reason === undefined) {
          const members = groups.get(groupKey);
          if (members === undefined) groups.set(groupKey, [target]);
          else members.push(target);
          lifeOf(target);
          return Effect.void;
        }
        return record(
          target,
          null,
          undefined,
          undefined,
          undefined,
          reason === "merged" || undefined,
        ).pipe(
          Effect.tap(() => ended(target, reason)),
          Effect.catchCause(
            logFailure("pull request watch stop failed", {
              threadId: target.thread.id,
              pullRequest: threadPullRequestKeyOf(target.link),
            }),
          ),
        );
      },
      { discard: true },
    );
    const now = yield* Clock.currentTimeMillis;
    // A watch started since the last failure reads at once and shares the read.
    const due = [...groups].flatMap(([key, targets]): ReadonlyArray<WatchGroup> =>
      targets.some((target) => (readRetryAt.get(readKey(target)) ?? 0) <= now)
        ? [{ key, targets }]
        : [],
    );
    yield* Effect.forEach(
      due,
      (group) => {
        const reference = referenceOf(group.targets[0]);
        // The host just reported a change, so a cached fingerprint may predate it.
        return (changed === undefined ? Effect.void : pullRequests.invalidate({ reference })).pipe(
          Effect.andThen(fingerprintOf(group)),
          Effect.tap((fingerprint) => {
            // Open pull request views refresh only when the host state moved.
            return changed !== undefined &&
              fingerprint !== null &&
              fingerprint !== "paused" &&
              group.targets.some((target) => {
                const last = lastReads.get(readKey(target));
                return last?.status !== fingerprint.status || last.remarks !== fingerprint.remarks;
              })
              ? pullRequests.invalidate({ reference }, { notifyReaders: true })
              : Effect.void;
          }),
          Effect.flatMap((fingerprint) =>
            fingerprint === "paused"
              ? Effect.void
              : readGroup(group, fingerprint, holdWake).pipe(
                  Effect.catchCause(
                    logFailure("pull request watch check failed", { pullRequest: group.key }),
                  ),
                ),
          ),
        );
      },
      { concurrency: 4, discard: true },
    );
    yield* sendHeld(held);
    if (changed === undefined) yield* sweepCursor.complete(page.after);
  }, passes.withPermit);

  const sweep = pass(undefined).pipe(
    Effect.catchCause(logFailure("pull request watch sweep failed", {})),
    Effect.withSpan("PullRequestWatchReactor.sweep"),
  );

  const readOnChange = (pullRequest: string) =>
    // Watches beyond the event read's budget still advance on the periodic sweep.
    NodeSqliteClient.backgroundReads(pass(pullRequest)).pipe(
      Effect.catchCause(logFailure("pull request watch change read failed", { pullRequest })),
      Effect.withSpan("PullRequestWatchReactor.readOnChange"),
    );

  // One feed per pull request: the host keeps one subscription per pull request and account.
  const follow = Effect.fnUntraced(function* (feeds: FiberMap.FiberMap<string>) {
    // Only pull requests whose host has a feed take one of the capped slots.
    const candidates = yield* Effect.filter(
      feedCandidates,
      ([, reference]) => pullRequests.followsChanges(reference),
      { concurrency: 8 },
    );
    const wanted = feedsToFollow(candidates);
    const stale = Array.from(feeds, ([pullRequest]) => pullRequest).filter(
      (pullRequest) => !wanted.has(pullRequest),
    );
    yield* Effect.forEach(stale, (pullRequest) => FiberMap.remove(feeds, pullRequest), {
      concurrency: "unbounded",
      discard: true,
    });
    for (const [pullRequest, reference] of wanted) {
      // An ended feed restarts here, so a host that refused it is asked again each sweep.
      yield* FiberMap.run(feeds, pullRequest, { onlyIfMissing: true })(
        pullRequests.changes(reference).pipe(
          Stream.debounce(EVENT_SETTLE),
          // Events that settle during a read queue one more.
          Stream.buffer({ capacity: 1, strategy: "sliding" }),
          Stream.runForEach(() => readOnChange(pullRequest)),
        ),
      );
    }
  });

  const start: PullRequestWatchReactor["Service"]["start"] = Effect.fn(
    "PullRequestWatchReactor.start",
  )(function* () {
    const feeds = yield* FiberMap.make<string>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (event.type !== "thread.pull-request-synced") return Effect.void;
        const unread = visibleThreadPullRequests(event.payload.pullRequests ?? []).flatMap(
          (link) =>
            link.watch === undefined || lives.has(lifeKeyOf(event.threadId, link, link.watch))
              ? []
              : [threadPullRequestKeyOf(link)],
        );
        if (unread.length === 0) return Effect.void;
        return hold.awaitRelease.pipe(
          Effect.andThen(Effect.forEach(new Set(unread), readOnChange, { discard: true })),
        );
      }).pipe(Effect.catchCause(logFailure("pull request watch event stream failed", {}))),
    );
    yield* forkParked(
      hold.awaitRelease.pipe(
        Effect.andThen(
          NodeSqliteClient.backgroundReads(sweep).pipe(
            Effect.andThen(follow(feeds)),
            Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`)),
            Effect.asVoid,
          ),
        ),
      ),
    );
  });

  return { start, sweep } satisfies PullRequestWatchReactor["Service"];
});

export const layer = Layer.effect(PullRequestWatchReactor, make);
