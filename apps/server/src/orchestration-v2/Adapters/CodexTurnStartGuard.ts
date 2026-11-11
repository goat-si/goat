import type { OrchestrationV2ProviderTurn } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { awaitingNativeStart } from "./CodexQueuedTurnStop.ts";
import type { makeCodexThreadStatuses } from "./codexThreadStatuses.ts";

type TurnStatus = OrchestrationV2ProviderTurn["status"];

interface RootTurnLike {
  readonly nativeTurnId: string;
  readonly nativeStartReady?: Deferred.Deferred<void>;
  readonly subagent: unknown;
  readonly input: { readonly attemptId: string };
  readonly providerThread: {
    readonly nativeThreadRef: { readonly nativeId: string | null } | null;
  };
}

type Busy =
  | { readonly type: "stopped"; readonly turnId: string }
  | { readonly type: "unowned"; readonly turnId: string }
  | { readonly type: "unknown" };

const UNOWNED_TURN =
  "Codex is running a turn on this conversation that GOAT did not start, so this could not start. Try again when that turn ends.";
const ORPHAN_LIMIT = 64;

const isRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

/**
 * Keeps GOAT from sending turn/start while Codex reports a turn in progress on the native thread.
 * A turn a Stop already ended is stopped again first; a turn GOAT never owned takes an ordinary
 * run's message as a steer and the run adopts it; anything else fails without sending the message.
 * A turn a tracked root owns is left to its run.
 */
export const makeCodexTurnStartGuard = <C extends RootTurnLike, E>(deps: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly statuses: ReturnType<typeof makeCodexThreadStatuses>;
  readonly activeTurns: Effect.Effect<ReadonlyMap<string, C>>;
  /** Turns a Stop already ended in GOAT that Codex may still run. */
  readonly stopped: (nativeTurnId: string) => boolean;
  /** Queued turns a Stop settled before Codex started them. */
  readonly abandoned: (nativeTurnId: string) => boolean;
  readonly settle: (context: C, status: TurnStatus) => Effect.Effect<unknown>;
  readonly fail: (detail: string) => Effect.Effect<never, E>;
}) => {
  // Turns a steer is being delivered to, with how Codex ended one before the run adopted it.
  const adoptions = new Map<string, TurnStatus | undefined>();
  // Goal turns no run owned that GOAT paused and stopped; Codex may keep running them.
  const orphans = new Set<string>();

  // Codex can report a thread busy without naming its turn, as on a connection that only learned
  // the thread's status from thread/resume while an earlier one still runs the turn
  const listedRunningTurn = (threadId: string) =>
    deps.client
      .request("thread/turns/list", {
        threadId,
        itemsView: "summary",
        sortDirection: "desc",
        limit: 10,
      })
      .pipe(
        Effect.map((page) => page.data.find((turn) => turn.status === "inProgress")?.id),
        Effect.timeoutOption("5 seconds"),
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );

  // A turn a tracked root owns, or one a start of ours still waits for, is that run's: the start
  // service stops one a run GOAT ended left behind, and Codex's answer to turn/start is checked
  // against its owner. Any other running turn is judged on its own, tracked roots or not.
  const classify = Effect.fnUntraced(function* (threadId: string) {
    if (!deps.statuses.working(threadId, deps.abandoned)) return undefined;
    const roots = Array.from((yield* deps.activeTurns).values()).filter(
      (context) =>
        context.subagent === null && context.providerThread.nativeThreadRef?.nativeId === threadId,
    );
    const reported = deps.statuses.runningTurn(threadId);
    if (reported === undefined && roots.length > 0 && deps.statuses.startPending(threadId))
      return undefined;
    const running = reported ?? (yield* listedRunningTurn(threadId));
    if (
      roots.length > 0 &&
      (running === undefined
        ? deps.statuses.startPending(threadId)
        : roots.some((context) => context.nativeTurnId === running))
    )
      return undefined;
    const busy: Busy =
      running === undefined
        ? { type: "unknown" }
        : deps.stopped(running) || orphans.has(running)
          ? { type: "stopped", turnId: running }
          : { type: "unowned", turnId: running };
    return busy;
  });

  return {
    /**
     * Before any side effect of a start: stops again a turn a Stop already ended, and fails when
     * Codex runs a turn this start cannot reach (a steer is only tried right before dispatch).
     */
    prepare: Effect.fn("CodexTurnStartGuard.prepare")(function* (threadId: string, steer: boolean) {
      const busy = yield* classify(threadId);
      if (busy === undefined || (busy.type === "unowned" && steer)) return;
      if (busy.type !== "stopped") return yield* deps.fail(UNOWNED_TURN);
      const stopped = yield* deps.client
        .request("turn/interrupt", { threadId, turnId: busy.turnId })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("orchestration-v2.codex-stopped-turn-stop-failed", { cause }),
          ),
          Effect.andThen(deps.statuses.whenQuiet(threadId, deps.abandoned)),
          Effect.timeoutOption("10 seconds"),
        );
      if (Option.isNone(stopped))
        return yield* deps.fail(
          "A turn GOAT already stopped is still running in Codex and did not stop within 10 seconds, so this message was not sent. Stop the thread and send it again.",
        );
    }),
    /**
     * Right before turn/start, after the start's preparation: checks and reserves the thread in one
     * step, or steers an ordinary run's message into a turn GOAT never owned and adopts that turn.
     */
    dispatch: Effect.fn("CodexTurnStartGuard.dispatch")(function* (input: {
      readonly threadId: string;
      readonly codexInput: ReadonlyArray<CodexSchema.V2TurnStartParams__UserInput>;
      /** The context turn/start would carry; a steer delivers it too. */
      readonly additionalContext:
        | Record<string, CodexSchema.V2TurnSteerParams__AdditionalContextEntry>
        | undefined;
      readonly steer: boolean;
      readonly reserve: () => {
        readonly failed: () => void;
        readonly answered: (turnId: string) => void;
      };
      /** Registers the run on the turn Codex took the steer into. */
      readonly adopt: (nativeTurnId: string) => Effect.Effect<C, E>;
    }) {
      const busy = yield* classify(input.threadId);
      if (busy === undefined) return { type: "start", reservation: input.reserve() } as const;
      if (busy.type !== "unowned" || !input.steer) return yield* deps.fail(UNOWNED_TURN);
      adoptions.set(busy.turnId, undefined);
      // Model, effort and permission settings have no steer field: the adopted turn keeps its own.
      const params = {
        threadId: input.threadId,
        expectedTurnId: busy.turnId,
        input: [...input.codexInput],
        ...(input.additionalContext === undefined
          ? {}
          : { additionalContext: input.additionalContext }),
      };
      const steered = yield* deps.client.request("turn/steer", params).pipe(Effect.exit);
      if (Exit.isFailure(steered)) {
        adoptions.delete(busy.turnId);
        yield* Effect.logWarning("orchestration-v2.codex-adopting-steer-failed", {
          cause: steered.cause,
        });
        const refused = steered.cause.reasons.some(
          (reason) => reason._tag === "Fail" && isRequestError(reason.error),
        );
        return yield* deps.fail(
          refused
            ? "Codex is running a turn GOAT did not start and refused this message, so it was not sent. Send it again when that turn ends."
            : "Codex did not confirm whether the turn it is running took this message, so GOAT did not send it again.",
        );
      }
      // Kept until the run owns the turn, so a completion arriving meanwhile is not lost.
      const adopted = yield* input.adopt(steered.value.turnId).pipe(
        Effect.map((context) => ({ context, ended: adoptions.get(busy.turnId) })),
        Effect.ensuring(Effect.sync(() => void adoptions.delete(busy.turnId))),
      );
      if (adopted.ended !== undefined) yield* deps.settle(adopted.context, adopted.ended);
      return { type: "adopted" } as const;
    }),
    /** Records how Codex ended a turn; a steer may still be delivering into it. */
    turnCompleted: (nativeTurnId: string, status: TurnStatus) => {
      orphans.delete(nativeTurnId);
      if (adoptions.has(nativeTurnId)) adoptions.set(nativeTurnId, status);
    },
    /** A goal turn no run owned that GOAT stopped; the next start stops it again, never steers. */
    orphanStopped: (nativeTurnId: string) => {
      orphans.add(nativeTurnId);
      for (const oldest of orphans) {
        if (orphans.size <= ORPHAN_LIMIT) break;
        orphans.delete(oldest);
      }
    },
    /** A steer may only name a turn Codex started and still runs; any other fails clearly. */
    awaitSteerable: Effect.fn("CodexTurnStartGuard.awaitSteerable")(function* (context: C) {
      const ready = context.nativeStartReady;
      if (ready !== undefined && awaitingNativeStart(context))
        yield* Deferred.await(ready).pipe(Effect.timeoutOption("10 seconds"));
      if (awaitingNativeStart(context))
        return yield* deps.fail(
          "Codex has not started this turn yet, so the message could not be steered. Send it again once the turn starts.",
        );
      if ((yield* deps.activeTurns).get(context.nativeTurnId) !== context)
        return yield* deps.fail(
          "This turn has already ended, so the message could not be steered.",
        );
    }),
  };
};
