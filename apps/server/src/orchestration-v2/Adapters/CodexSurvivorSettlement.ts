import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type { ProviderDriverKind, ProviderTurnId, ThreadId } from "@goat/contracts";

type SurvivorContext = {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly projectionThreadId: ThreadId;
  readonly nativeTurnId: string;
  readonly providerThread: ProviderAdapter.ProviderAdapterV2TurnInput["providerThread"];
  readonly providerTurnId: ProviderTurnId;
  readonly providerTurnOrdinal: number;
  readonly providerNodeId: ProviderAdapter.ProviderAdapterV2TurnInput["rootNodeId"];
  readonly startedAt: DateTime.Utc;
};
type RootTerminal = Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>;

export const makeSurvivorSettlement = <A extends SurvivorContext>(input: {
  readonly driver: ProviderDriverKind;
  readonly activeTurns: Ref.Ref<Map<string, A>>;
  readonly turnWaiters: Ref.Ref<Map<string, Deferred.Deferred<void>>>;
  readonly emitProviderEvent: (
    event: ProviderAdapter.ProviderAdapterV2Event,
  ) => Effect.Effect<void>;
  readonly makeRootTerminalEvent: (input: {
    context: A;
    status: "completed" | "interrupted" | "failed";
    failureMessage?: string;
  }) => Effect.Effect<RootTerminal>;
  readonly emitRootTerminal: (context: A, event: RootTerminal) => Effect.Effect<void>;
  /** Tells the thread's status that the survivor turn ended, which Codex may never report. */
  readonly turnEnded: (nativeThreadId: string, nativeTurnId: string) => void;
}) =>
  Effect.fn("CodexSurvivorContinuation.settle")(function* (
    context: A,
    status: "completed" | "interrupted" | "failed",
    detail?: string,
    runFailure?: string,
  ) {
    yield* input.emitProviderEvent({
      type: "provider_turn.updated",
      driver: input.driver,
      threadId: context.projectionThreadId,
      providerTurn: {
        id: context.providerTurnId,
        providerThreadId: context.providerThread.id,
        nodeId: context.providerNodeId,
        runAttemptId: context.input.attemptId,
        nativeTurnRef: { driver: input.driver, nativeId: context.nativeTurnId, strength: "strong" },
        ordinal: context.providerTurnOrdinal,
        status,
        startedAt: context.startedAt,
        completedAt: yield* DateTime.now,
      },
    });
    const failureMessage = runFailure ?? detail;
    const terminal = yield* input.makeRootTerminalEvent({
      context,
      status: runFailure === undefined ? status : "failed",
      ...(failureMessage === undefined ? {} : { failureMessage }),
    });
    yield* input.emitRootTerminal(context, terminal);
    yield* Ref.update(input.activeTurns, (turns) => {
      if (turns.get(context.nativeTurnId) !== context) return turns;
      const next = new Map(turns);
      next.delete(context.nativeTurnId);
      return next;
    });
    const waiter = (yield* Ref.get(input.turnWaiters)).get(context.nativeTurnId);
    const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
    if (nativeThreadId != null) input.turnEnded(nativeThreadId, context.nativeTurnId);
    if (waiter !== undefined) yield* Deferred.succeed(waiter, undefined);
  });
