import type { OrchestrationV2ProviderThread } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ClaudeCloudError, isClaudeCloudError } from "./protocol.ts";
import type { SessionRead } from "./sessionRead.ts";
import { countPrompts, readSessionReply, type ReplyAnchor } from "./transcript.ts";

type Thread = OrchestrationV2ProviderThread;
type Task = NonNullable<Thread["cloudTask"]>;
interface PullRequest {
  readonly prUrl: string;
  readonly branch: string;
  readonly summary: string;
}

export const OBSERVATION_WINDOW_MS = 2 * 60 * 60 * 1000;
const PULL_REQUEST_INTERVAL_MS = 60_000;
/**
 * Gaps between session reads; the last one repeats. Every read runs one small paid model turn,
 * so reads back off instead of following the PR poll's one-minute interval.
 */
const SESSION_READ_CADENCE_MS = [30_000, 60_000, 120_000, 240_000, 600_000] as const;
/** Consecutive failed reads after which GOAT stops reading and says so. */
const READ_FAILURE_LIMIT = 3;
export const FOLLOW_UP_ACCEPTED = "Follow-up accepted";
const RUNNING = "Running in the cloud";
const PR_WAITING = "Found a session-linked PR; waiting for the session to finish";
const SUMMARY_LIMIT = 4000;
const RESULT_LABEL = "Result PR found";
const RESULT_CAVEAT = "PR presence does not confirm that the session stopped or its checks passed.";
/** The PR's summary, bounded, with why the PR stands in for the session's reply. */
const resultSummary = (summary: string, note: string) =>
  [
    RESULT_LABEL,
    summary.slice(0, SUMMARY_LIMIT - RESULT_LABEL.length - note.length - RESULT_CAVEAT.length - 3),
    note,
    RESULT_CAVEAT,
  ].join("\n");
/** The saved summary is bounded; the run's result message carries the full reply. */
const shorten = (text: string) =>
  text.length <= SUMMARY_LIMIT ? text : text.slice(0, SUMMARY_LIMIT - 1) + "…";
/** A reply summary cut to fit; recovery reads the session again for the whole reply. */
export const isShortenedReply = (task: Task) =>
  task.progress?.startsWith(REPLIED) === true &&
  task.summary?.length === SUMMARY_LIMIT &&
  task.summary.endsWith("…");
const dollars = (cost: number) => "$" + cost.toFixed(4);
const REPLIED = "Session replied";

export type Observation =
  | { readonly kind: "done" }
  | { readonly kind: "replied"; readonly text: string }
  | { readonly kind: "failed"; readonly error: ClaudeCloudError };
export interface RunAnchor {
  readonly startedAt: DateTime.Utc;
  readonly followUp: boolean;
  /** How the run owns its cloud prompt; see ReplyAnchor. */
  readonly ownership: ReplyAnchor["ownership"];
  /** The run's own message; without it any prompt after the boundary counts. */
  readonly prompt?: string | undefined;
  /** Cloud prompts the session held before this run sent its own; see ReplyAnchor. */
  readonly after: number;
  /** Receives the prompt count of every transcript read, the boundary for the next run. */
  readonly onRead: (prompts: number) => void;
}
const anchorOf = (input: RunAnchor): ReplyAnchor => ({
  ownership: input.ownership,
  after: input.after,
  ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
});

export const UNKNOWN_RUN =
  "GOAT could not read this run's saved history, so it cannot tell which cloud reply is the run's.";

/**
 * How a run owns its cloud prompt. A run is the session's first exactly when it is not a
 * follow-up; the saved history confirms it. `seen` holds, per thread, the prompts the session had
 * at its latest read: a later run's prompt comes after them, and after a restart nothing is known
 * so the whole transcript competes. Without history and without a known kind (`followUp`
 * undefined) nothing is claimed.
 */
export const runAnchor = (input: {
  readonly startedAt: DateTime.Utc;
  readonly history: { readonly prompt: string | undefined; readonly first: boolean } | undefined;
  readonly followUp: boolean | undefined;
  readonly registered: boolean;
  readonly message?: string;
  readonly seen: Map<string, number>;
  readonly key: string;
}): RunAnchor | undefined => {
  if (input.history === undefined && input.followUp === undefined) return undefined;
  const first = input.history?.first ?? !input.followUp;
  return {
    startedAt: input.startedAt,
    followUp: input.followUp ?? !first,
    ownership: !first ? "unique" : input.registered ? "latest" : "creation",
    after: input.seen.get(input.key) ?? 0,
    onRead: (count) => input.seen.set(input.key, count),
    prompt: input.message ?? input.history?.prompt,
  };
};

/** The run's full reply from one more read, for a result whose saved summary was cut. */
export const recoverCloudReply = Effect.fn("ClaudeCloudAdapter.recoverReply")(function* (
  input: RunAnchor & { readonly readSession: () => Effect.Effect<SessionRead, ClaudeCloudError> },
) {
  const read = yield* input.readSession().pipe(Effect.result);
  if (read._tag === "Failure") return undefined;
  input.onRead(countPrompts(read.success.transcript));
  const reply = readSessionReply(read.success.transcript, anchorOf(input));
  return reply.state === "replied" ? reply.text : undefined;
});

/**
 * Follows one run until the cloud session answers it. Reading the session is the primary signal.
 * A first turn also polls for a session-linked PR. A PR found while a read confirms the session is
 * still working is recorded and the run keeps waiting for the reply; the PR completes the run on
 * its own only when the session cannot be read. A follow-up has no PR of its own to wait for, so
 * when reads fail it settles on the admission receipt as it did before reads existed.
 */
export const observeCloudSession = Effect.fn("ClaudeCloudAdapter.observe")(function* (
  input: RunAnchor & {
    readonly thread: () => Thread;
    readonly commit: (thread: Thread) => Effect.Effect<void, ClaudeCloudError>;
    readonly findPullRequest: () => Effect.Effect<PullRequest | null, ClaudeCloudError>;
    readonly readSession: () => Effect.Effect<SessionRead, ClaudeCloudError>;
  },
) {
  const started = DateTime.toEpochMillis(input.startedAt);
  const deadline = started + OBSERVATION_WINDOW_MS;
  const anchor = anchorOf(input);
  let base = input.followUp ? FOLLOW_UP_ACCEPTED : RUNNING;
  const clock = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  // A PR recorded before a restart still stands in if the session can't be read or time runs
  // out. A follow-up's task drops any earlier run's PR when it is accepted, so it has none here.
  const saved = input.thread().cloudTask;
  let pullRequest: PullRequest | undefined =
    !input.followUp && saved?.status === "running" && saved.prUrl && saved.branch
      ? { prUrl: saved.prUrl, branch: saved.branch, summary: saved.summary ?? "" }
      : undefined;
  if (pullRequest) base = RUNNING + ". " + PR_WAITING;
  let nextPullRequest = input.followUp || pullRequest ? Number.POSITIVE_INFINITY : yield* clock;
  let nextRead = (yield* clock) + SESSION_READ_CADENCE_MS[0];
  let reads = 0;
  let failures = 0;
  let spent = 0;
  let costUnknown = false;
  let readable = true;
  let unreadable = "";
  let pullRequestError: string | undefined;
  let pullRequestCause: unknown;

  const save = Effect.fn("ClaudeCloudAdapter.saveObservation")(function* (
    change: (task: Task) => Task,
    status?: Thread["status"],
  ) {
    const at = yield* DateTime.now;
    const thread = input.thread();
    if (!thread.cloudTask)
      return yield* new ClaudeCloudError({
        detail: "The saved cloud task disappeared while GOAT was following it.",
        outcome: "uncertain",
      });
    yield* input.commit({
      ...thread,
      ...(status === undefined ? {} : { status }),
      updatedAt: at,
      cloudTask: { ...change(thread.cloudTask), updatedAt: DateTime.formatIso(at) },
    });
  });
  const spentText = () =>
    reads +
    (reads === 1 ? " read, " : " reads, ") +
    (costUnknown ? "at least " : "") +
    dollars(spent);

  /** A read that told GOAT nothing; the third in a row ends reading with this reason. */
  const failedRead = Effect.fn("ClaudeCloudAdapter.failedRead")(function* (
    reason: string,
  ): Effect.fn.Return<Observation | undefined, ClaudeCloudError> {
    failures += 1;
    if (failures < READ_FAILURE_LIMIT) {
      yield* save((task) => ({
        ...task,
        progress: base + ". The last session check failed (" + reason + "); GOAT will retry.",
      }));
      return undefined;
    }
    readable = false;
    unreadable = reason;
    if (input.followUp) {
      yield* save((task) => ({
        ...task,
        progress: FOLLOW_UP_ACCEPTED + ". GOAT can't read the cloud session.",
        summary:
          "Follow-up accepted, but GOAT can't read the cloud session (" +
          reason +
          "). Open the session for the reply.",
      }));
      return { kind: "done" };
    }
    if (pullRequest) return yield* pullRequestResult(pullRequest);
    yield* save((task) => ({
      ...task,
      progress:
        RUNNING +
        ". GOAT can't read the session (" +
        reason +
        "), so it waits for a session-linked PR instead.",
    }));
    return undefined;
  });

  const read = Effect.fn("ClaudeCloudAdapter.readSessionOnce")(function* (): Effect.fn.Return<
    Observation | undefined,
    ClaudeCloudError
  > {
    const left = Math.max(deadline - (yield* clock), 1);
    const result = yield* input.readSession().pipe(Effect.timeout(left), Effect.result);
    reads += 1;
    if (result._tag === "Failure")
      return yield* failedRead(
        isClaudeCloudError(result.failure) ? result.failure.detail : "The session read timed out.",
      );
    const cost = result.success.costUsd;
    if (cost === null) costUnknown = true;
    else spent += cost;
    input.onRead(countPrompts(result.success.transcript));
    const reply = readSessionReply(result.success.transcript, anchor);
    if (reply.state === "unattributable") return yield* failedRead(reply.reason);
    failures = 0;
    if (reply.state === "replied") {
      yield* save(
        ({ error: _error, ...task }) => ({
          ...task,
          ...pullRequest,
          status: "succeeded",
          tracking: "polled",
          progress: REPLIED + " (" + spentText() + ")",
          summary: shorten(reply.text),
        }),
        "idle",
      );
      return { kind: "replied", text: reply.text };
    }
    if (reply.state === "failed") {
      yield* save(
        (task) => ({
          ...task,
          status: "failed",
          progress: "Session reported an error (" + spentText() + ")",
          error: reply.error,
          summary: shorten(reply.error),
        }),
        "idle",
      );
      return {
        kind: "failed",
        error: new ClaudeCloudError({ detail: reply.error, outcome: "uncertain" }),
      };
    }
    const state =
      reply.state === "waiting"
        ? "GOAT's message has not reached the session yet"
        : "still working";
    const last = cost === null ? "cost unknown" : dollars(cost);
    yield* save((task) => ({
      ...task,
      progress:
        base + ". Session checked: " + state + " (last read " + last + "; " + spentText() + ").",
    }));
    return undefined;
  });

  /** Completes from the PR once the session can't be read or the deadline passed, saying which. */
  const pullRequestResult = Effect.fn("ClaudeCloudAdapter.pullRequestResult")(function* (
    found: PullRequest,
  ): Effect.fn.Return<Observation, ClaudeCloudError> {
    const note = readable
      ? "The session had not finished its turn within two hours."
      : "GOAT can't read the session (" + unreadable + ").";
    yield* save(
      ({ error: _error, ...task }) => ({
        ...task,
        ...found,
        status: "succeeded",
        tracking: "polled",
        progress: RESULT_LABEL + ". " + note,
        summary: resultSummary(found.summary, note),
      }),
      "idle",
    );
    return { kind: "done" };
  });
  const nextReadAfter = Effect.fn("ClaudeCloudAdapter.scheduleRead")(function* () {
    const gap = SESSION_READ_CADENCE_MS[Math.min(reads, SESSION_READ_CADENCE_MS.length - 1)];
    nextRead = (yield* clock) + (gap ?? SESSION_READ_CADENCE_MS[0]);
  });

  while (true) {
    const now = yield* clock;
    if (now >= deadline) {
      if (pullRequest) return yield* pullRequestResult(pullRequest);
      if (input.followUp) {
        yield* save((task) => ({
          ...task,
          summary:
            "Follow-up accepted. GOAT did not see the reply within two hours; open the cloud session.",
        }));
        return { kind: "done" } as const;
      }
      return yield* new ClaudeCloudError({
        outcome: "uncertain",
        detail:
          "The cloud session had not replied and no session-linked PR was confirmed within two hours. The session may still be running." +
          (pullRequestError ? " " + pullRequestError : ""),
        ...(pullRequestCause === undefined ? {} : { cause: pullRequestCause }),
      });
    }
    if (now >= nextPullRequest) {
      const found = yield* input
        .findPullRequest()
        .pipe(Effect.timeout(deadline - now), Effect.result);
      if (found._tag === "Success" && found.success !== null) {
        if (!readable) return yield* pullRequestResult(found.success);
        // A PR often lands before the session's last message: record it and keep reading. It
        // stands as the result only if reading fails for good or the deadline passes.
        pullRequest = found.success;
        nextPullRequest = Number.POSITIVE_INFINITY;
        base = RUNNING + ". " + PR_WAITING;
        const recorded = found.success;
        yield* save((task) => ({
          ...task,
          prUrl: recorded.prUrl,
          branch: recorded.branch,
          // Kept so the PR can still stand in for the reply after a restart.
          summary: shorten(recorded.summary),
          progress: base + ".",
        }));
        nextRead = yield* clock;
        continue;
      }
      if (found._tag === "Failure") {
        pullRequestError =
          "GitHub observation was incomplete; check project source-control access.";
        pullRequestCause = found.failure;
      }
      nextPullRequest = (yield* clock) + PULL_REQUEST_INTERVAL_MS;
    }
    if (readable && (yield* clock) >= nextRead) {
      const outcome = yield* read();
      if (outcome !== undefined) return outcome;
      yield* nextReadAfter();
    }
    const wake = Math.min(nextPullRequest, readable ? nextRead : deadline, deadline);
    const wait = wake - (yield* clock);
    if (wait > 0) yield* Effect.sleep(wait);
  }
});
