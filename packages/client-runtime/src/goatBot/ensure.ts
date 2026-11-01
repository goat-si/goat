import type { GoatBotEnsureState, GoatBotRef } from "./availability.ts";

/**
 * Asking the server for its GOAT Bot, kept honest across reconnects. Every
 * request gets a token; only the answer to the request still pending counts.
 * A new connection generation or a retry voids whatever was in flight.
 */
export interface GoatBotEnsureMachine {
  readonly generation: string | null;
  readonly token: number;
  readonly pending: number | null;
  readonly ensure: GoatBotEnsureState;
}

export type GoatBotEnsureResult =
  | { readonly kind: "confirmed"; readonly bot: GoatBotRef }
  | { readonly kind: "legacy_active" }
  | { readonly kind: "failed"; readonly message: string };

export const initialGoatBotEnsure: GoatBotEnsureMachine = {
  generation: null,
  token: 0,
  pending: null,
  ensure: { state: "idle" },
};

/** A different machine, connection or capability starts over. */
export function syncGoatBotEnsure(
  machine: GoatBotEnsureMachine,
  generation: string | null,
): GoatBotEnsureMachine {
  if (machine.generation === generation) return machine;
  return { generation, token: machine.token + 1, pending: null, ensure: { state: "idle" } };
}

/** Starts a request and returns the token its answer must carry. */
export function startGoatBotEnsure(machine: GoatBotEnsureMachine): {
  readonly machine: GoatBotEnsureMachine;
  readonly token: number;
} {
  const token = machine.token + 1;
  return { machine: { ...machine, token, pending: token, ensure: { state: "pending" } }, token };
}

/** Voids anything in flight so the next start asks again. */
export function retryGoatBotEnsure(machine: GoatBotEnsureMachine): GoatBotEnsureMachine {
  return { ...machine, token: machine.token + 1, pending: null, ensure: { state: "idle" } };
}

/** Applies an answer only when it belongs to the request still pending. */
export function settleGoatBotEnsure(
  machine: GoatBotEnsureMachine,
  token: number,
  result: GoatBotEnsureResult,
): GoatBotEnsureMachine {
  if (machine.pending === null || machine.pending !== token) return machine;
  const ensure: GoatBotEnsureState =
    result.kind === "confirmed"
      ? { state: "confirmed", bot: result.bot }
      : result.kind === "legacy_active"
        ? { state: "legacy_active" }
        : { state: "failed", message: result.message };
  return { ...machine, pending: null, ensure };
}
