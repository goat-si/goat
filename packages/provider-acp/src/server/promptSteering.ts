import type { ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import type { ActiveAcpTurn } from "./activeTurn.ts";
import { sendPromptWhenIdle } from "./promptWhenIdle.ts";
import type { PromptOutcomeCheck } from "./retiredPromptOutcome.ts";

/** Numbers the turn's next prompt; the check turns true once a later prompt follows it. */
export function followNextPrompt(context: ActiveAcpTurn): () => boolean {
  const sequence = ++context.promptSequence;
  return () => context.promptSequence !== sequence;
}

export interface AcpPromptSettle {
  readonly generation: number;
  readonly checkPromptOutcome: PromptOutcomeCheck | undefined;
}

export interface AcpPromptSteerDeps {
  readonly driver: ProviderDriverKind;
  readonly activeTurn: Ref.Ref<ActiveAcpTurn | null>;
  readonly transitionPermit: Semaphore.Semaphore;
  readonly currentGeneration: Effect.Effect<number>;
  readonly atGeneration: <A>(
    generation: number,
    effect: Effect.Effect<A>,
  ) => Effect.Effect<Option.Option<A>>;
  readonly sessionScope: Scope.Scope;
  readonly promptContent: (
    message: ProviderAdapter.ProviderAdapterV2SteerInput["message"],
  ) => Effect.Effect<
    ReadonlyArray<EffectAcpSchema.ContentBlock>,
    ProviderAdapter.ProviderAdapterProtocolError
  >;
  readonly watchOutcome: (sessionId: string) => Effect.Effect<PromptOutcomeCheck | undefined>;
  readonly startInactivityWatchdog: (
    context: ActiveAcpTurn,
    settle: AcpPromptSettle,
  ) => Effect.Effect<void>;
  readonly prompt: (
    prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>,
    options: {
      readonly dispatched: Deferred.Deferred<void>;
      readonly released: Deferred.Deferred<void>;
    },
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly followPrompt: (
    context: ActiveAcpTurn,
    prompt: (
      superseded: () => boolean,
    ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>,
    settle: AcpPromptSettle,
  ) => Effect.Effect<void>;
}

/** Reopens the turn for a steer prompt and returns the earlier prompt's runtime release. */
const reopenTurnForSteer = Effect.fnUntraced(function* (context: ActiveAcpTurn, now: number) {
  const released = context.foregroundIdle;
  context.foregroundIdle = yield* Deferred.make<void>();
  if (yield* Deferred.isDone(context.promptWireSettled)) {
    context.promptWireSettled = yield* Deferred.make<void, never>();
  }
  context.promptSettled = false;
  context.promptSettledStatus = null;
  context.backgroundFinalizeGeneration += 1;
  context.lastProgressAt = now;
  const watchdog = context.inactivityWatchdog;
  context.inactivityWatchdog = undefined;
  if (watchdog !== undefined) yield* Fiber.interrupt(watchdog).pipe(Effect.forkDetach);
  return released;
});

/**
 * Sends a steer as the turn's next `session/prompt` while the earlier one still runs, with no
 * `session/cancel`, so the agent's tools and subagents keep running. The earlier prompt's return
 * no longer settles the turn; the latest prompt's stop reason does.
 */
export function makeAcpPromptSteer(deps: AcpPromptSteerDeps) {
  const notSteerable = (providerTurnId: string, reason: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: deps.driver,
      detail: `Provider turn ${providerTurnId} ${reason}.`,
    });
  return Effect.fn("AcpAdapterV2.steerWithPrompt")(function* (
    turnInput: ProviderAdapter.ProviderAdapterV2SteerInput,
  ) {
    const blocks = yield* deps.promptContent(turnInput.message);
    const { context, dispatched } = yield* deps.transitionPermit.withPermit(
      Effect.gen(function* () {
        const context = yield* Ref.get(deps.activeTurn);
        if (
          context === null ||
          context.finalized ||
          context.interrupted ||
          context.providerTurnId !== turnInput.providerTurnId
        ) {
          return yield* notSteerable(
            turnInput.providerTurnId,
            "is not active and cannot be steered",
          );
        }
        // A wake turn has no prompt of its own to steer; its reply ends the run soon.
        if (context.promptSequence === 0) {
          return yield* new ProviderAdapter.ProviderAdapterSteerDeclinedError({
            driver: deps.driver,
            providerThreadId: turnInput.providerThread.id,
            providerTurnId: turnInput.providerTurnId,
          });
        }
        const generation = yield* deps.currentGeneration;
        const settle = {
          generation,
          checkPromptOutcome: yield* deps.watchOutcome(context.nativeThreadId),
        };
        const dispatched = yield* Deferred.make<void>();
        const now = yield* Clock.currentTimeMillis;
        const steered = yield* deps.atGeneration(
          generation,
          Effect.gen(function* () {
            if (context.finalized || context.interrupted) return false;
            const released = yield* reopenTurnForSteer(context, now);
            yield* deps.startInactivityWatchdog(context, settle);
            const steerReleased = context.foregroundIdle;
            yield* deps
              .followPrompt(
                context,
                (superseded) =>
                  sendPromptWhenIdle(
                    context,
                    () => deps.prompt(blocks, { dispatched, released: steerReleased }),
                    superseded,
                  ),
                settle,
              )
              .pipe(Effect.forkIn(deps.sessionScope));
            yield* Deferred.succeed(released, undefined);
            return true;
          }),
        );
        if (!Option.contains(steered, true)) {
          return yield* notSteerable(turnInput.providerTurnId, "ended before it could be steered");
        }
        return { context, dispatched };
      }),
    );
    const sent = yield* Effect.raceFirst(
      Deferred.await(dispatched).pipe(Effect.as(true)),
      Deferred.await(context.completed).pipe(Effect.as(false)),
    );
    if (!sent) {
      return yield* notSteerable(turnInput.providerTurnId, "ended before it could be steered");
    }
  });
}
