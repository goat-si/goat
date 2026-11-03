import type { OrchestrationV2ProviderThread } from "@goat/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

interface Sized {
  readonly size: number;
}

/** The parts of a Codex turn context the probes read. */
export interface CodexLiveTurn<Turn> {
  readonly nativeTurnId: string;
  readonly providerThread: { readonly id: string };
  readonly subagent: { readonly parentContext: Turn } | null;
}

/** Whether this turn, or any turn it descends from, belongs to the provider thread. */
export const descendsFromCodexThread = <Turn extends CodexLiveTurn<Turn>>(
  context: Turn | undefined,
  providerThreadId: string,
): boolean => {
  for (let turn = context; turn; turn = turn.subagent?.parentContext)
    if (turn.providerThread.id === providerThreadId) return true;
  return false;
};

/** Reads the goal from Codex; a failed or slow read keeps it active. */
const goalStillActive = (client: CodexClient.CodexAppServerClient["Service"], threadId: string) =>
  client.request("thread/goal/get", { threadId }).pipe(
    Effect.map(
      (response) =>
        response.goal != null &&
        response.goal.status !== "paused" &&
        response.goal.status !== "complete",
    ),
    Effect.catchTags({
      CodexAppServerRequestError: (error) =>
        error.code === -32600 && error.errorMessage === "goals feature is disabled"
          ? Effect.succeed(false)
          : Effect.fail(error),
    }),
    Effect.timeout("15 seconds"),
    Effect.option,
    Effect.map(Option.getOrElse(() => true)),
  );

/**
 * Background-work probes and live-work holds of one Codex app-server session. Pending work
 * pins idle release up to its ceiling; live work (turns, requests, survivors, goals and
 * subagents) holds it past the ceiling, since Codex can keep working with no GOAT turn.
 */
export const makeCodexLiveWork = <Turn extends CodexLiveTurn<Turn>>(input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly activeTurns: Effect.Effect<ReadonlyMap<string, Turn>>;
  readonly settledTurns: Effect.Effect<ReadonlyMap<string, Turn>>;
  readonly runningCommandItems: Effect.Effect<ReadonlyMap<string, Sized>>;
  readonly runningDynamicTools: Effect.Effect<ReadonlyMap<string, Sized>>;
  readonly pendingMcpAppCaptures: Effect.Effect<Sized>;
  readonly imageTurns: ReadonlyMap<string, { readonly running: Sized; readonly saved: Sized }>;
  readonly subagentThreads: Effect.Effect<
    ReadonlyMap<
      string,
      { readonly task: { readonly status: string }; readonly parentContext: Turn }
    >
  >;
  readonly pendingSubagentTurns: Effect.Effect<Sized>;
  readonly pendingRuntimeRequests: Effect.Effect<Sized>;
  readonly goalsByNativeThread: ReadonlyMap<string, { readonly status: string } | null>;
  readonly survivors: {
    readonly waiting: ReadonlyMap<string, unknown>;
    /** Goal threads whose persisted goal block is not yet confirmed. */
    readonly pendingGoalThreads: ReadonlySet<string>;
    /** Goal threads whose persisted goal block this session still holds; none if unreadable. */
    readonly fencedGoalThreads: Effect.Effect<Option.Option<ReadonlyArray<string>>>;
  };
  readonly turnHasRetainedBackgroundWork: (nativeTurnId: string) => Effect.Effect<boolean>;
}) => {
  const unfinishedSubagent = (subagent: { readonly task: { readonly status: string } }) =>
    subagent.task.status === "running" || subagent.task.status === "pending";
  const goalActive = (nativeThreadId: string) =>
    input.goalsByNativeThread.get(nativeThreadId)?.status === "active" ||
    input.survivors.pendingGoalThreads.has(nativeThreadId);

  // Idle release can beat delayed subagent resumes: Codex reports them completed between turns with no resume-expected signal.
  const hasPendingBackgroundWork = Effect.gen(function* () {
    for (const items of (yield* input.runningCommandItems).values())
      if (items.size > 0) return true;
    for (const items of (yield* input.runningDynamicTools).values())
      if (items.size > 0) return true;
    if ((yield* input.pendingMcpAppCaptures).size > 0) return true;
    for (const state of input.imageTurns.values())
      if (state.running.size > 0 || state.saved.size > 0) return true;
    for (const subagent of (yield* input.subagentThreads).values())
      if (unfinishedSubagent(subagent)) return true;
    return false;
  });

  const hasPendingBackgroundWorkForThread = Effect.fn(
    "CodexAdapterV2.hasPendingBackgroundWorkForThread",
  )(function* (providerThread: OrchestrationV2ProviderThread) {
    const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
    if (
      nativeThreadId != null &&
      (goalActive(nativeThreadId) || input.survivors.waiting.has(nativeThreadId))
    )
      return true;
    // Owned through any turn it descends from, even one gone from both maps while its work
    // runs, so an intermediate parent's thread counts its running subagents too.
    const owned = (context: Turn) => descendsFromCodexThread(context, providerThread.id);
    const active = yield* input.activeTurns;
    for (const context of [...active.values(), ...(yield* input.settledTurns).values()]) {
      if (!owned(context)) continue;
      if (yield* input.turnHasRetainedBackgroundWork(context.nativeTurnId)) return true;
      if (context.subagent !== null && active.has(context.nativeTurnId)) return true;
    }
    for (const subagent of (yield* input.subagentThreads).values())
      if (unfinishedSubagent(subagent) && owned(subagent.parentContext)) return true;
    return false;
  });

  const holdsLiveWork = Effect.fn("CodexLiveWork.holdsLiveWork")(function* (options: {
    readonly pastPinCeiling: boolean;
  }) {
    if ((yield* input.activeTurns).size > 0) return true;
    if ((yield* input.pendingRuntimeRequests).size > 0) return true;
    if (input.survivors.waiting.size > 0) return true;
    if ((yield* input.pendingSubagentTurns).size > 0) return true;
    for (const subagent of (yield* input.subagentThreads).values())
      if (unfinishedSubagent(subagent)) return true;
    const fenced = yield* input.survivors.fencedGoalThreads;
    if (Option.isNone(fenced)) return true;
    const goals = new Set([
      ...[...input.goalsByNativeThread]
        .filter(([, goal]) => goal?.status === "active")
        .map(([nativeThreadId]) => nativeThreadId),
      ...input.survivors.pendingGoalThreads,
      ...fenced.value,
    ]);
    if (!options.pastPinCeiling) return goals.size > 0;
    // Past the ceiling cached goals and leftover blocks can be stale, so Codex confirms them.
    for (const nativeThreadId of goals)
      if (yield* goalStillActive(input.client, nativeThreadId)) return true;
    return false;
  });

  return { hasPendingBackgroundWork, hasPendingBackgroundWorkForThread, holdsLiveWork };
};
