import { OrchestratorMcpThreadReadResult, RunId, type RuntimeMode } from "@goat/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import {
  EXCERPT_MAX_CHARS,
  failureFromRemoteStatus,
  type LaunchWatch,
  type LaunchWatchRunDetails,
  type LaunchWatchTerminalStatus,
  noRunDetails,
  RemoteRunFailureStatus,
} from "./launchWatch.ts";
import { lastText } from "./launchWatchText.ts";
import { runFailure } from "./threadStatus.ts";

/**
 * What a launch watch's follower reads about its thread: the details a report quotes, and, while
 * nothing is owed, a look for a run the thread started on its own.
 */

export const REMOTE_READ_TIMEOUT_MS = 60_000;
const TAIL_WINDOW = 40;
const TAIL_PAGE = 20;
const TAIL_PAGES = 3;

/** The watch's launcher thread was deleted or archived, so the watch ends. */
export class LauncherGone extends Data.TaggedError("LauncherGone")<{}> {}

/** What a look at an idle watch's thread found. */
export type Look =
  | { readonly _tag: "Run"; readonly runId: RunId | null }
  | { readonly _tag: "Gone" }
  | { readonly _tag: "LauncherGone" }
  | { readonly _tag: "Unreachable"; readonly error: string };

const decodeRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeFailureStatus = Schema.decodeUnknownEffect(RemoteRunFailureStatus);
const decodeLatestRun = Schema.decodeUnknownEffect(
  Schema.Struct({ run: Schema.NullOr(Schema.Struct({ runId: RunId })) }),
);

/** The thread's active run when it is another than the one that ended. */
const laterRun = (active: RunId | null | undefined, ended: RunId) =>
  active == null || active === ended ? null : active;

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
        runIds: [runId],
        turnItemRunIds: [runId],
        turnItemTypes: ["assistant_message", "error"],
      },
    );
    const run = records.runs.find((candidate) => candidate.id === runId) ?? null;
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
      failure: runFailure(run, records.turnItems),
      continuedIn: laterRun(shell?.activeRunId, runId),
      trigger: run?.userMessageId ?? null,
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
    const read = (args: Record<string, unknown>) =>
      callHost(
        watch,
        host,
        "goat_thread_read",
        { threadId: watch.threadId, ...args },
        REMOTE_READ_TIMEOUT_MS,
      ).pipe(Effect.flatMap(decodeRead));
    const head = yield* read({ view: "messages", limit: 1, runLimit: 1 });
    const start = head.thread.itemCount - TAIL_WINDOW - 1;
    let afterPosition: number | undefined = start < 0 ? undefined : start;
    const texts: Array<string | null> = [];
    let trigger: string | null = null;
    for (let page = 0; page < TAIL_PAGES; page++) {
      const result = yield* read({
        view: "messages",
        limit: TAIL_PAGE,
        maxCharsPerItem: EXCERPT_MAX_CHARS,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      });
      for (const item of result.items) {
        if (item.type === "assistant_message" && item.runId === runId) texts.push(item.text);
        if (item.type === "user_message" && item.runId === runId) trigger ??= item.messageId;
      }
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
      continuedIn: laterRun(head.thread.activeRunId, runId),
      trigger,
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

  const localLook = Effect.fn("LaunchWatchReads.localLook")(function* (watch: LaunchWatch) {
    yield* deps.launcherCeiling(watch);
    const shell = yield* threads.getThreadShell(watch.threadId);
    if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null)
      return { _tag: "Gone" } satisfies Look;
    return { _tag: "Run", runId: shell.activeRunId ?? shell.latestRunId ?? null } satisfies Look;
  });

  const remoteLook = (watch: LaunchWatch, host: string) =>
    callHost(
      watch,
      host,
      "goat_thread_status",
      { threadId: watch.threadId },
      REMOTE_READ_TIMEOUT_MS,
    ).pipe(
      Effect.flatMap(decodeLatestRun),
      Effect.map((status): Look => ({ _tag: "Run", runId: status.run?.runId ?? null })),
      Effect.timeoutOption(REMOTE_READ_TIMEOUT_MS * 2),
      Effect.map(
        Option.getOrElse((): Look => ({
          _tag: "Unreachable",
          error: `${host} did not answer in time.`,
        })),
      ),
    );

  /** The thread's active run, else its latest; a remote thread is asked with goat_thread_status. */
  const look = Effect.fn("LaunchWatchReads.look")(
    function* (watch: LaunchWatch) {
      const found: Look =
        watch.host === null ? yield* localLook(watch) : yield* remoteLook(watch, watch.host);
      return found;
    },
    Effect.catch((error) => Effect.succeed(lookFailure(error))),
  );

  return { detailsFor, look };
};
