import * as Effect from "effect/Effect";

/** Checks other services register to keep the expiry sweep off handoffs they are still ending. */
export const makeExpiryHolds = () => {
  const holds = new Set<(handoffId: string) => boolean>();
  return {
    held: (handoffId: string) => [...holds].some((check) => check(handoffId)),
    /** Registers a check; the returned function removes it again. */
    hold: (check: (handoffId: string) => boolean) =>
      Effect.sync(() => {
        holds.add(check);
        return () => void holds.delete(check);
      }),
  };
};
