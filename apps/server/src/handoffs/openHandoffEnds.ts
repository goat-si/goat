import {
  type Handoff,
  HandoffError,
  type HandoffReadInput,
  isHandoffPending,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";

import { holdsThread } from "./approvalHold.ts";

/** Ending an open handoff without a person: the asking agent withdraws it, or GOAT drops it. */
export const makeOpenHandoffEnds = (deps: {
  readonly lock: Semaphore.Semaphore;
  readonly read: (input: HandoffReadInput) => Effect.Effect<Handoff, HandoffError>;
  readonly end: (
    input: HandoffReadInput,
    actor: Handoff["actor"],
    resultMessage?: string,
  ) => Effect.Effect<Handoff, HandoffError>;
}) => ({
  withdraw: Effect.fn("Handoffs.withdraw")(function* (input: HandoffReadInput) {
    const record = yield* deps.read(input);
    if (!holdsThread(record)) return yield* new HandoffError({ reason: "invalid_request" });
    if (!isHandoffPending(record.state)) return yield* new HandoffError({ reason: "conflict" });
    return yield* deps.end(input, { type: "agent", threadId: input.threadId });
  }, deps.lock.withPermits(1)),
  cancelPending: Effect.fn("Handoffs.cancelPending")(function* (
    input: HandoffReadInput,
    resultMessage: string,
  ) {
    const record = yield* deps.read(input);
    if (!isHandoffPending(record.state)) return record;
    return yield* deps.end(input, { type: "server" }, resultMessage);
  }, deps.lock.withPermits(1)),
});
