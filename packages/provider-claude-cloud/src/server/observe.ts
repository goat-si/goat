import type { OrchestrationV2ProviderThread } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ClaudeCloudError, isClaudeCloudError } from "./protocol.ts";
import type { SessionRead } from "./sessionRead.ts";
import { readSessionReply, type ReplyAnchor } from "./transcript.ts";

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
const SUMMARY_LIMIT = 4000;
const RESULT_LABEL = "Result PR found";
const RESULT_CAVEAT = "PR presence does not confirm that the session stopped or its checks passed.";
const resultSummary = (summary: string) =>
  [
    RESULT_LABEL,
    summary.slice(0, SUMMARY_LIMIT - RESULT_LABEL.length - RESULT_CAVEAT.length - 2),
    RESULT_CAVEAT,
  ].join("\n");
/** The saved summary is bounded; the run's result message carries the full reply. */
const shorten = (text: string) =>
  text.length <= SUMMARY_LIMIT ? text : text.slice(0, SUMMARY_LIMIT - 1) + "…";
const dollars = (cost: number) => "$" + cost.toFixed(4);

export type Observation =
  | { readonly kind: "done" }
  | { readonly kind: "replied"; readonly text: string }
  | { readonly kind: "failed"; readonly error: ClaudeCloudError };

/**
 * Follows one run until the cloud session answers it. Reading the session is the primary signal.
 * A first turn also polls for a session-linked PR as before, which completes the run on its own
 * when reads fail. A follow-up has no PR of its own to wait for, so when reads fail it settles on
 * the admission receipt as it did before reads existed.
 */
export const observeCloudSession = Effect.fn("ClaudeCloudAdapter.observe")(function* (input: {
  readonly thread: () => Thread;
  readonly commit: (thread: Thread) => Effect.Effect<void, ClaudeCloudError>;
  readonly findPullRequest: () => Effect.Effect<PullRequest | null, ClaudeCloudError>;
  readonly readSession: () => Effect.Effect<SessionRead, ClaudeCloudError>;
  readonly startedAt: DateTime.Utc;
  readonly followUp: boolean;
  /** A session registered after its prompt: its latest prompt is this run's. */
  readonly registered: boolean;
  readonly prompt?: string;
}) {
  const started = DateTime.toEpochMillis(input.startedAt);
  const deadline = started + OBSERVATION_WINDOW_MS;
  const anchor: ReplyAnchor = {
    since: started,
    latest: input.registered && !input.followUp,
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
  };
  const base = input.followUp ? FOLLOW_UP_ACCEPTED : RUNNING;
  const clock = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  let nextPullRequest = input.followUp ? Number.POSITIVE_INFINITY : yield* clock;
  let nextRead = (yield* clock) + SESSION_READ_CADENCE_MS[0];
  let reads = 0;
  let failures = 0;
  let spent = 0;
  let costUnknown = false;
  let readable = true;
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

  const read = Effect.fn("ClaudeCloudAdapter.readSessionOnce")(function* (
    pullRequest?: PullRequest,
  ) {
    const left = Math.max(deadline - (yield* clock), 1);
    const result = yield* input.readSession().pipe(Effect.timeout(left), Effect.result);
    reads += 1;
    if (result._tag === "Failure") {
      failures += 1;
      const reason = isClaudeCloudError(result.failure)
        ? result.failure.detail
        : "The session read timed out.";
      if (failures < READ_FAILURE_LIMIT) {
        yield* save((task) => ({
          ...task,
          progress: base + ". The last session check failed (" + reason + "); GOAT will retry.",
        }));
        return undefined;
      }
      readable = false;
      if (input.followUp) {
        yield* save((task) => ({
          ...task,
          progress: FOLLOW_UP_ACCEPTED + ". GOAT can't read the cloud session.",
          summary:
            "Follow-up accepted, but GOAT can't read the cloud session (" +
            reason +
            "). Open the session for the reply.",
        }));
        return { kind: "done" } as const;
      }
      yield* save((task) => ({
        ...task,
        progress:
          RUNNING +
          ". GOAT can't read the session (" +
          reason +
          "), so it waits for a session-linked PR instead.",
      }));
      return undefined;
    }
    failures = 0;
    const cost = result.success.costUsd;
    if (cost === null) costUnknown = true;
    else spent += cost;
    const reply = readSessionReply(result.success.transcript, anchor);
    if (reply.state === "replied") {
      yield* save(
        ({ error: _error, ...task }) => ({
          ...task,
          ...pullRequest,
          status: "succeeded",
          tracking: "polled",
          progress: "Session replied (" + spentText() + ")",
          summary: shorten(reply.text),
        }),
        "idle",
      );
      return { kind: "replied", text: reply.text } as const;
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
      } as const;
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

  const pullRequestResult = Effect.fn("ClaudeCloudAdapter.pullRequestResult")(function* (
    found: PullRequest,
  ) {
    // A PR often lands just before the session's last message; one read can still import it.
    if (readable) {
      const outcome = yield* read(found);
      if (outcome !== undefined && outcome.kind !== "done") return outcome;
    }
    yield* save(
      ({ error: _error, ...task }) => ({
        ...task,
        ...found,
        status: "succeeded",
        tracking: "polled",
        progress: RESULT_LABEL,
        summary: resultSummary(found.summary),
      }),
      "idle",
    );
    return { kind: "done" } as const;
  });

  while (true) {
    const now = yield* clock;
    if (now >= deadline) {
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
      if (found._tag === "Success" && found.success !== null)
        return yield* pullRequestResult(found.success);
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
      const gap = SESSION_READ_CADENCE_MS[Math.min(reads, SESSION_READ_CADENCE_MS.length - 1)];
      nextRead = (yield* clock) + (gap ?? SESSION_READ_CADENCE_MS[0]);
    }
    const wake = Math.min(nextPullRequest, readable ? nextRead : deadline, deadline);
    const wait = wake - (yield* clock);
    if (wait > 0) yield* Effect.sleep(wait);
  }
});
