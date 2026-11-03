import {
  BROWSER_CLAIM_ANSWER_HANDOFF_PATH,
  HandoffError,
  isHandoffPending,
  type Handoff,
  type HandoffReadInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";

export const makeBrowserClaimEnd = (deps: {
  readonly read: (input: HandoffReadInput) => Effect.Effect<Handoff, HandoffError>;
  readonly transition: (
    input: HandoffReadInput,
    state: Handoff["state"],
    actor: Handoff["actor"],
    keepPrivate?: boolean,
    computerUseScope?: "session" | "always",
    onResolved?: Effect.Effect<void, HandoffError>,
    resultMessage?: string,
  ) => Effect.Effect<Handoff, HandoffError>;
  readonly lock: Semaphore.Semaphore;
}) =>
  Effect.fn("Handoffs.endBrowserClaim")(
    (input: HandoffReadInput, state: "cancelled" | "expired", reason: string) =>
      deps.lock.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* deps.read(input);
          if (record.target.path !== BROWSER_CLAIM_ANSWER_HANDOFF_PATH)
            return yield* new HandoffError({ reason: "invalid_request" });
          if (!isHandoffPending(record.state)) return record;
          return yield* deps.transition(
            input,
            state,
            { type: "server" },
            false,
            undefined,
            undefined,
            reason,
          );
        }),
      ),
  );
