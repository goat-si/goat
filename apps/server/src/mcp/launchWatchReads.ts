import {
  type OrchestrationV2Run,
  OrchestratorMcpThreadReadResult,
  type RunId,
  type RuntimeMode,
} from "@goat/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import {
  EXCERPT_MAX_CHARS,
  failureFromRemoteStatus,
  isTerminalStatus,
  type LaunchWatch,
  type LaunchWatchRunDetails,
  type LaunchWatchTerminalStatus,
  noRunDetails,
  RemoteRunFailureStatus,
  type WatchedRun,
} from "./launchWatch.ts";
import { lastText } from "./launchWatchText.ts";
import { runFailure } from "./threadStatus.ts";

/**
 * What a launch watch's follower reads about its thread: the details a report quotes, and, while
 * nothing is owed, a look for runs the thread started since the last one.
 */

export const REMOTE_READ_TIMEOUT_MS = 60_000;
const TAIL_WINDOW = 40;
const TAIL_PAGE = 20;
const TAIL_PAGES = 3;
/** Runs a remote read lists; more than this between two looks are not each reported. */
const RUN_WINDOW = 20;
/** Messages a remote look reads to tell who started its new runs. */
const LOOK_MESSAGES = 50;

/** The watch's launcher thread was deleted or archived, so the watch ends. */
export class LauncherGone extends Data.TaggedError("LauncherGone")<{}> {}

/** What a look at an idle watch's thread found: its runs when there are new ones, else none. */
export type Look =
  | { readonly _tag: "Runs"; readonly runs: ReadonlyArray<WatchedRun> }
  | { readonly _tag: "Gone" }
  | { readonly _tag: "LauncherGone" }
  | { readonly _tag: "Unreachable"; readonly error: string };

const decodeRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeFailureStatus = Schema.decodeUnknownEffect(RemoteRunFailureStatus);
type RemoteRead = OrchestratorMcpThreadReadResult;

const localRun = (run: OrchestrationV2Run): WatchedRun => ({
  runId: run.id,
  ordinal: run.ordinal,
  terminal: isTerminalStatus(run.status),
  requestedAt: DateTime.toEpochMillis(run.requestedAt),
  completedAt: run.completedAt === null ? null : DateTime.toEpochMillis(run.completedAt),
  trigger: run.userMessageId,
});

const remoteRuns = (read: RemoteRead, triggers: ReadonlyMap<string, string>): Array<WatchedRun> =>
  read.recentRuns.map((run) => ({
    runId: run.runId,
    ordinal: run.ordinal,
    terminal: isTerminalStatus(run.status),
    requestedAt: Date.parse(run.requestedAt),
    completedAt: run.completedAt === null ? null : Date.parse(run.completedAt),
    trigger: triggers.get(run.runId),
  }));

/**
 * The message that started each run whose start the items show: the run's first item, when it is
 * a user message and the items reach back past it (to an earlier run, or the thread's start).
 * A later message in a run may be a steer from anyone, so it never names who started the run.
 */
const startTriggers = (items: ReadonlyArray<RemoteRead["items"][number]>, fromStart: boolean) => {
  const triggers = new Map<string, string>();
  const runs = new Set<string>();
  let reachesBack = fromStart;
  for (const item of items.toSorted((left, right) => left.position - right.position)) {
    if (item.runId === null) continue;
    if (!runs.has(item.runId)) {
      runs.add(item.runId);
      if (reachesBack && item.type === "user_message" && item.messageId !== null)
        triggers.set(item.runId, item.messageId);
    }
    reachesBack = true;
  }
  return triggers;
};

export const makeLaunchWatchReads = <CeilingError, HostError>(deps: {
  readonly threads: ThreadManagementService.ThreadManagementServiceShape;
  readonly launcherCeiling: (watch: LaunchWatch) => Effect.Effect<RuntimeMode, CeilingError>;
  readonly callHost: (
    watch: LaunchWatch,
    host: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ) => Effect.Effect<unknown, HostError>;
}) => {
  const { threads, callHost } = deps;

  const remoteRead = (watch: LaunchWatch, host: string, args: Record<string, unknown>) =>
    callHost(
      watch,
      host,
      "goat_thread_read",
      { threadId: watch.threadId, view: "messages", ...args },
      REMOTE_READ_TIMEOUT_MS,
    ).pipe(Effect.flatMap(decodeRead));

  const localDetails = Effect.fn("LaunchWatchReads.localDetails")(function* (
    watch: LaunchWatch,
    runId: RunId,
  ) {
    const shell = yield* threads.getThreadShell(watch.threadId);
    const records = yield* threads.getThreadRecords(
      watch.threadId,
      ["messages", "providerThreads", "runs", "turnItems"],
      {
        messageRoles: ["assistant"],
        messageRunIds: [runId],
        turnItemRunIds: [runId],
        turnItemTypes: ["assistant_message", "error"],
      },
    );
    return {
      title: shell?.title ?? null,
      branch: shell?.branch ?? null,
      worktreePath: shell?.worktreePath ?? null,
      excerpt: lastText(records.messages.map((message) => message.text)),
      prUrl: shell?.linkedPullRequest?.url ?? null,
      linkOnlyRegistration: (records.providerThreads ?? []).some(
        (thread) =>
          thread.cloudTask?.attach === "registered" && thread.cloudTask.tracking === "link-only",
      ),
      failure: runFailure(records.runs.find((run) => run.id === runId) ?? null, records.turnItems),
      runs: records.runs.map(localRun),
    } satisfies LaunchWatchRunDetails;
  });

  /**
   * Reads the end of a remote transcript for the followed run's last answer.
   * Positions count every visible item while the messages view only filters,
   * so the read starts a fixed window before the end.
   */
  const remoteDetails = Effect.fn("LaunchWatchReads.remoteDetails")(function* (
    watch: LaunchWatch,
    host: string,
    runId: RunId,
    status: LaunchWatchTerminalStatus,
  ) {
    const head = yield* remoteRead(watch, host, { limit: 1, runLimit: RUN_WINDOW });
    const start = head.thread.itemCount - TAIL_WINDOW - 1;
    let afterPosition: number | undefined = start < 0 ? undefined : start;
    const texts: Array<string | null> = [];
    const items: Array<RemoteRead["items"][number]> = [];
    for (let page = 0; page < TAIL_PAGES; page++) {
      const result = yield* remoteRead(watch, host, {
        limit: TAIL_PAGE,
        maxCharsPerItem: EXCERPT_MAX_CHARS,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      });
      for (const item of result.items)
        if (item.type === "assistant_message" && item.runId === runId) texts.push(item.text);
      items.push(...result.items);
      if (!result.hasMore || result.nextPosition === null) break;
      afterPosition = result.nextPosition;
    }
    const excerpt = lastText(texts);
    // A run that failed before its agent spoke has nothing to quote; its status says why.
    const failure =
      status === "failed" && excerpt === null
        ? yield* callHost(
            watch,
            host,
            "goat_thread_status",
            { threadId: watch.threadId },
            REMOTE_READ_TIMEOUT_MS,
          ).pipe(
            Effect.flatMap(decodeFailureStatus),
            Effect.map((remote) => failureFromRemoteStatus(remote, runId)),
            Effect.catchIf(
              (error) => !(error instanceof LauncherGone),
              (error) =>
                Effect.logDebug("launch watch: failure status unreadable", {
                  host,
                  cause: error,
                }).pipe(Effect.as(null)),
            ),
          )
        : null;
    return {
      title: head.thread.title,
      branch: head.thread.branch,
      worktreePath: head.thread.worktreePath,
      excerpt,
      prUrl: head.thread.linkedPullRequest?.url ?? null,
      // Registered runs live on their holder, whose own watch reads them locally.
      linkOnlyRegistration: false,
      failure,
      runs: remoteRuns(head, startTriggers(items, start < 0)),
    } satisfies LaunchWatchRunDetails;
  });

  /** Details make a wake more useful but never hold it back. */
  const detailsFor = Effect.fn("LaunchWatchReads.detailsFor")(
    function* (watch: LaunchWatch, runId: RunId, status: LaunchWatchTerminalStatus) {
      const details: LaunchWatchRunDetails =
        watch.host === null
          ? yield* localDetails(watch, runId)
          : yield* remoteDetails(watch, watch.host, runId, status);
      return details;
    },
    Effect.timeoutOption(REMOTE_READ_TIMEOUT_MS * 2),
    Effect.map(Option.getOrElse(() => noRunDetails)),
    (effect, watch) =>
      Effect.catch(effect, (error) =>
        Effect.logDebug("launch watch: details unavailable", {
          watchId: watch.id,
          cause: error,
        }).pipe(Effect.as(noRunDetails)),
      ),
  );

  const lookFailure = (error: unknown): Look => {
    if (error instanceof LauncherGone) return { _tag: "LauncherGone" };
    if (
      error instanceof SshRemoteDispatch.SshRemoteDispatchError &&
      error.reason === "remote_refused" &&
      error.remoteCode === "thread_not_found"
    )
      return { _tag: "Gone" };
    return { _tag: "Unreachable", error: String(error) };
  };

  /** A local look reads the runs only when the thread's latest run is not the one last seen. */
  const localLook = Effect.fn("LaunchWatchReads.localLook")(function* (watch: LaunchWatch) {
    yield* deps.launcherCeiling(watch);
    const shell = yield* threads.getThreadShell(watch.threadId);
    if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null)
      return { _tag: "Gone" } satisfies Look;
    if (shell.latestRunId == null || shell.latestRunId === watch.seen?.runId)
      return { _tag: "Runs", runs: [] } satisfies Look;
    const records = yield* threads.getThreadRecords(watch.threadId, ["runs"]);
    return { _tag: "Runs", runs: records.runs.map(localRun) } satisfies Look;
  });

  /**
   * One goat_thread_read lists the remote thread's recent runs, which hosts of every version
   * answer. Only when a run is new does a second read find the messages that started them.
   */
  const remoteLook = Effect.fn("LaunchWatchReads.remoteLook")(function* (
    watch: LaunchWatch,
    host: string,
  ) {
    const head = yield* remoteRead(watch, host, { limit: 1, runLimit: RUN_WINDOW });
    const newest = head.recentRuns[0];
    if (newest === undefined || newest.ordinal <= (watch.seen?.ordinal ?? 0))
      return { _tag: "Runs", runs: [] } satisfies Look;
    const start = head.thread.itemCount - LOOK_MESSAGES - 1;
    const tail = yield* remoteRead(watch, host, {
      limit: LOOK_MESSAGES,
      maxCharsPerItem: 1,
      ...(start < 0 ? {} : { afterPosition: start }),
    });
    return {
      _tag: "Runs",
      runs: remoteRuns(head, startTriggers(tail.items, start < 0)),
    } satisfies Look;
  });

  /** The thread's runs since the last look; an unanswered remote look counts as unreachable. */
  const look = Effect.fn("LaunchWatchReads.look")(
    function* (watch: LaunchWatch) {
      const found: Look =
        watch.host === null
          ? yield* localLook(watch)
          : yield* remoteLook(watch, watch.host).pipe(
              Effect.timeoutOption(REMOTE_READ_TIMEOUT_MS * 2),
              Effect.map(
                Option.getOrElse((): Look => ({
                  _tag: "Unreachable",
                  error: "The host did not answer in time.",
                })),
              ),
            );
      return found;
    },
    Effect.catch((error) => Effect.succeed(lookFailure(error))),
  );

  return { detailsFor, look };
};
