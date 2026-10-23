import * as Effect from "effect/Effect";

type Settled<R> = Exclude<R, { readonly kind: "needs_human" }>;
const isSettled = <R extends { readonly kind: string }>(result: R): result is Settled<R> =>
  result.kind !== "needs_human";

/**
 * Status, forget and sign-in follow-up tools share a service result with siblings that ask a
 * person, but never ask one themselves. Their schemas say so; a handoff from one is a bug.
 */
export const settled =
  (tool: string) =>
  <R extends { readonly kind: string }>(result: R): Effect.Effect<Settled<R>> =>
    isSettled(result)
      ? Effect.succeed(result)
      : Effect.die(new Error(`${tool} returned needs_human, which it never asks for.`));
