/**
 * Whether a coding thread a task launched still owes the task its result: the thread ended a run,
 * and the launch watch's wake for that end has not yet reached the launcher as one of the task's
 * own runs. The caller reads the ends (readLaunchedEnds) before the launcher's runs, so a wake
 * already sent is among those runs.
 */
import type {
  ChannelChildWork,
  ChannelTask,
  OrchestrationV2Run,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { sessionTaskRuns } from "./channelBotSessionRuns.ts";
import { parseLaunchWake } from "./channelLaunchWake.ts";
import { isThreadMissing } from "./channelWorkerObservation.ts";

const ENDED = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

/** What the launch watch for a launched thread says, or "unreadable" when it could not be read. */
export type LaunchWakeWatch =
  | {
      readonly detached: boolean;
      readonly skippedRuns: ReadonlyArray<string>;
      readonly reportedEnds: Readonly<Record<string, string>>;
    }
  | null
  | "unreadable";

export interface LaunchedEnd {
  readonly launcherThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  /** The launched thread's newest run that ended. */
  readonly runId: RunId;
  /** That end as the launch watch names it (formatIso of completedAt), or null when unknown. */
  readonly endIso: string | null;
  readonly watch: LaunchWakeWatch;
}

/** The launch watch, as channel tasks read it for the threads they launched on this machine. */
export class ChannelLaunchWakes extends Context.Service<
  ChannelLaunchWakes,
  {
    /** The watch that wakes the launcher when the thread ends a run; "unreadable" on failure. */
    readonly watch: (
      launcherThreadId: ThreadId,
      threadId: ThreadId,
    ) => Effect.Effect<LaunchWakeWatch>;
  }
>()("goat/channels/channelLaunchedResults/ChannelLaunchWakes") {}

const wakesFor = (end: LaunchedEnd, runs: ReadonlyArray<OrchestrationV2Run>) =>
  runs.flatMap((run) => {
    const wake = parseLaunchWake(run.userMessageId);
    return wake !== undefined &&
      wake.launcher === end.launcherThreadId &&
      wake.host === "" &&
      wake.thread === end.childThreadId &&
      wake.runId === end.runId
      ? [wake]
      : [];
  });

/**
 * Whether a wake reports this end, by the launch watch's own end ids: a later end carries its id,
 * and the first wake covers the end the watch recorded first. Two ends with the same id are one
 * end to the watch, which never reports it twice.
 */
const covers = (end: LaunchedEnd, wake: { readonly end: string | null }) => {
  if (end.endIso === null) return true;
  if (wake.end !== null) return wake.end === end.endIso;
  const recorded =
    end.watch !== null && end.watch !== "unreadable"
      ? end.watch.reportedEnds[end.runId]
      : undefined;
  return recorded === undefined || recorded === end.endIso;
};

/**
 * True while the result is owed. `ownRuns` are the launcher's runs that serve the task; a wake
 * elsewhere in `allRuns` that is not one of them cannot be the task's result, so it keeps the
 * result owed whatever the watch says.
 */
export function launchedResultOwed(
  end: LaunchedEnd,
  ownRuns: ReadonlyArray<OrchestrationV2Run>,
  allRuns: ReadonlyArray<OrchestrationV2Run> = ownRuns,
): boolean {
  if (wakesFor(end, ownRuns).some((wake) => covers(end, wake))) return false;
  if (wakesFor(end, allRuns).some((wake) => covers(end, wake))) return true;
  const watch = end.watch;
  if (watch === "unreadable") return true;
  if (watch === null || watch.detached || watch.skippedRuns.includes(end.runId)) return false;
  return true;
}

/**
 * For each coding thread a generation launched from `launcherThreadId` that has finished: its
 * newest ended run and its launch watch. "unreadable" when the thread could not be read; a deleted
 * thread owes nothing.
 */
export const readLaunchedEnds = (
  deps: {
    readonly threads: ThreadManagement.ThreadManagementService["Service"];
    readonly watch: (
      launcherThreadId: ThreadId,
      threadId: ThreadId,
    ) => Effect.Effect<LaunchWakeWatch>;
  },
  records: ReadonlyArray<ChannelChildWork> | "unknown",
  generation: number,
  launcherThreadId: ThreadId,
) =>
  Effect.forEach(
    records === "unknown"
      ? []
      : records.flatMap((record) =>
          record.generation === generation &&
          record.surface === "thread_launch" &&
          record.state === "completed" &&
          record.callerThreadId === launcherThreadId &&
          record.destination?.threadId !== undefined
            ? [record.destination.threadId]
            : [],
        ),
    (childThreadId) =>
      Effect.gen(function* () {
        const read = yield* deps.threads
          .getThreadRecords(childThreadId, ["runs"])
          .pipe(Effect.result);
        if (read._tag === "Failure")
          return isThreadMissing(read.failure) ? [] : (["unreadable"] as const);
        const ended = read.success.runs
          .filter((run) => ENDED.has(run.status))
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .at(-1);
        if (ended === undefined) return [];
        const end: LaunchedEnd = {
          launcherThreadId,
          childThreadId,
          runId: ended.id,
          endIso: ended.completedAt === null ? null : DateTime.formatIso(ended.completedAt),
          watch: yield* deps.watch(launcherThreadId, childThreadId),
        };
        return [end];
      }),
    { concurrency: 1 },
  ).pipe(Effect.map((ends) => ends.flat()));

/** Whether any of these ends still owes its result to the task whose runs are `ownRuns`. */
export const anyLaunchedResultOwed = (
  ends: ReadonlyArray<LaunchedEnd | "unreadable">,
  ownRuns: ReadonlyArray<OrchestrationV2Run>,
  allRuns: ReadonlyArray<OrchestrationV2Run>,
) => ends.some((end) => end === "unreadable" || launchedResultOwed(end, ownRuns, allRuns));

/**
 * Whether a task on this GOAT Bot session still owes a launched thread's result there. The
 * session's runs are read after the ends, so a wake sent before its watch went is among them.
 */
export const owesLaunched = Effect.fn("ChannelBotSession.owesLaunched")(function* (
  deps: Parameters<typeof readLaunchedEnds>[0] & { readonly sql: SqlClient.SqlClient },
  sessionThreadId: ThreadId,
  task: Pick<ChannelTask, "taskId" | "generation">,
  childWork: ReadonlyArray<ChannelChildWork>,
) {
  const ends = yield* readLaunchedEnds(deps, childWork, task.generation, sessionThreadId);
  if (ends.length === 0) return false;
  const records = yield* deps.threads
    .getThreadRecords(sessionThreadId, ["runs", "messages"])
    .pipe(Effect.option);
  if (records._tag === "None") return true;
  // A wake that arrived since the caller's own read is a live run the session must not lose.
  if (records.value.runs.some((run) => !ENDED.has(run.status))) return true;
  const own = yield* sessionTaskRuns(deps.sql, sessionThreadId, records.value, task);
  return anyLaunchedResultOwed(ends, own, records.value.runs);
});
