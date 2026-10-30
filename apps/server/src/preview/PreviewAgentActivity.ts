import type { ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

export interface PreviewAgentTurnChange {
  readonly threadId: ThreadId;
  readonly active: boolean;
}

/**
 * Whether an agent turn runs on a thread, model thinking included, so its preview tab
 * stays focused between tool calls. Background commands outlive the turn and do not count.
 */
export class PreviewAgentActivity extends Context.Service<
  PreviewAgentActivity,
  {
    /** Marks the thread active until the returned effect runs; it runs at most once. */
    readonly begin: (threadId: ThreadId, runId?: string) => Effect.Effect<Effect.Effect<void>>;
    readonly active: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly currentRun: (threadId: ThreadId) => Effect.Effect<string | undefined>;
    readonly isRunActive: (threadId: ThreadId, runId: string) => Effect.Effect<boolean>;
    readonly onRunEnd: (
      handler: (threadId: ThreadId, runId: string) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** Each thread's transitions between no turn and some turn, from subscription on. */
    readonly changes: Effect.Effect<
      PubSub.Subscription<PreviewAgentTurnChange>,
      never,
      Scope.Scope
    >;
  }
>()("goat/preview/PreviewAgentActivity") {}

const make = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<PreviewAgentTurnChange>();
  // A token per turn, so overlapping turns on one thread end only when the last does.
  const turns = new Map<ThreadId, Map<symbol, string | undefined>>();
  const endHandlers = new Set<(threadId: ThreadId, runId: string) => void>();

  const begin = Effect.fn("PreviewAgentActivity.begin")(function* (
    threadId: ThreadId,
    runId?: string,
  ) {
    const existing = turns.get(threadId);
    const tokens = existing ?? new Map<symbol, string | undefined>();
    if (existing === undefined) turns.set(threadId, tokens);
    const token = Symbol(threadId);
    tokens.set(token, runId);
    if (existing === undefined) yield* PubSub.publish(changes, { threadId, active: true });
    return Effect.suspend(() => {
      if (!tokens.delete(token)) return Effect.void;
      if (runId !== undefined && ![...tokens.values()].includes(runId))
        for (const handler of endHandlers) handler(threadId, runId);
      if (tokens.size > 0) return Effect.void;
      if (turns.get(threadId) === tokens) turns.delete(threadId);
      return PubSub.publish(changes, { threadId, active: false }).pipe(Effect.asVoid);
    });
  });

  return PreviewAgentActivity.of({
    begin,
    active: Effect.fn("PreviewAgentActivity.active")(function (threadId) {
      return Effect.sync(() => turns.has(threadId));
    }),
    currentRun: Effect.fn("PreviewAgentActivity.currentRun")(function (threadId) {
      return Effect.sync(() => [...(turns.get(threadId)?.values() ?? [])].at(-1));
    }),
    isRunActive: (threadId, runId) =>
      Effect.sync(() => [...(turns.get(threadId)?.values() ?? [])].includes(runId)),
    onRunEnd: (handler) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          endHandlers.add(handler);
        }),
        () =>
          Effect.sync(() => {
            endHandlers.delete(handler);
          }),
      ).pipe(Effect.asVoid),
    changes: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(PreviewAgentActivity, make);
