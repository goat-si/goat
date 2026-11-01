import type { ThreadHealth } from "./threadHealthModel.ts";

/**
 * The reschedule decision from docs/internals/agentic-k8s.md "Reschedule decision", as one pure
 * function the goal controller calls each reconcile. Rescheduler.reschedule performs the moves;
 * the controller owns steering, fallback (T3) and the goal's Blocked state.
 */
export type RescheduleReason =
  | "stalled"
  | "host_unreachable"
  | "failed"
  | "drain"
  | "fallback_relaunch"
  | "manual";

export type HealingStep =
  | { readonly _tag: "none" }
  | { readonly _tag: "interrupt_and_steer"; readonly message: string }
  | { readonly _tag: "fallback" }
  | { readonly _tag: "blocked"; readonly reason: string }
  | { readonly _tag: "reschedule"; readonly reason: RescheduleReason };

const STEER_MESSAGE = "Continue; report status.";
export const MAX_ATTEMPTS_PER_WORKER = 3;
const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;

export function nextHealingStep(
  health: ThreadHealth,
  context: {
    /** The same observation already got its first action in this episode. */
    readonly repeated: boolean;
    /** The fallback chain has no step left for this failure. */
    readonly fallbackExhausted: boolean;
    readonly hostDraining: boolean;
  },
): HealingStep {
  switch (health._tag) {
    case "stalled":
      return context.repeated
        ? { _tag: "reschedule", reason: "stalled" }
        : { _tag: "interrupt_and_steer", message: STEER_MESSAGE };
    case "host_lost":
      return { _tag: "reschedule", reason: "host_unreachable" };
    case "failed":
      switch (health.failureClass) {
        case "usage_limit":
        case "provider_error":
        case "transport_error":
          return context.fallbackExhausted
            ? { _tag: "reschedule", reason: "failed" }
            : { _tag: "fallback" };
        case "permission_error":
        case "validation_error":
          return { _tag: "blocked", reason: health.failureClass };
        case "unknown":
          return { _tag: "reschedule", reason: "failed" };
      }
      return { _tag: "none" };
    case "healthy":
      // Drain moves an attempt only between runs; a running turn is left to finish.
      return context.hostDraining && health.idle === true
        ? { _tag: "reschedule", reason: "drain" }
        : { _tag: "none" };
    case "waiting":
    case "unknown":
      return { _tag: "none" };
  }
}

/** Full jitter: uniform in [0, min(max, base * 2^attempt)). random is injected for tests. */
export function backoffDelayMs(attempt: number, random: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.floor(Math.max(0, Math.min(1, random)) * ceiling);
}

const ATTEMPT_SUFFIX = /-a(\d+)$/u;

/** The attempt a branch belongs to: its -a<n> suffix, else the first attempt. */
export const attemptOfBranch = (branch: string) => {
  const match = branch.match(ATTEMPT_SUFFIX);
  return match === null ? 1 : Number(match[1]);
};

/** Each attempt gets its own branch, so a returning stale attempt can never push over its successor. */
export const nextAttemptBranch = (branch: string) =>
  branch.replace(ATTEMPT_SUFFIX, "") + "-a" + (attemptOfBranch(branch) + 1);

export function resumeNote(input: {
  readonly fromHost: string;
  readonly fromThreadId: string;
  readonly fromBranch: string | null;
  readonly resumedFrom: "branch" | "replica" | "base";
  readonly newBranch: string;
  readonly reason: RescheduleReason;
}): string {
  const source =
    input.resumedFrom === "branch"
      ? "branch " + input.fromBranch + " as pushed to origin"
      : input.resumedFrom === "replica"
        ? "a replica of its last finished turn"
        : "the goal's base branch, because nothing was pushed";
  return [
    "GOAT moved this work from thread " +
      input.fromThreadId +
      " on " +
      input.fromHost +
      " (" +
      input.reason.replace("_", " ") +
      ").",
    "You are on the new branch " + input.newBranch + ", started from " + source + ".",
    "Check git log and git status first; work after the last push was lost, so redo it if needed.",
  ].join("\n");
}

export const fenceNote = (input: {
  readonly successorHost: string;
  readonly successorBranch: string;
}) =>
  "This attempt was superseded: the work continues on " +
  input.successorHost +
  " on branch " +
  input.successorBranch +
  ". Stop here and do not push again.";
