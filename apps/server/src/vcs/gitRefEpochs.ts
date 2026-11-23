import * as Effect from "effect/Effect";

export function makeRefEpochs(capacity: number) {
  const epochs = new Map<string, number>();
  let sequence = 0;
  const advance = Effect.fn("GitVcsDriver.advanceListRefsEpoch")(function* (
    cwd: string,
    invalidate: (epoch: number) => Effect.Effect<void>,
  ) {
    const previous = epochs.get(cwd);
    const next = ++sequence;
    epochs.delete(cwd);
    epochs.set(cwd, next);
    if (epochs.size > capacity) {
      const oldest = epochs.keys().next().value;
      if (oldest !== undefined) epochs.delete(oldest);
    }
    if (previous !== undefined) yield* invalidate(previous);
    return next;
  });
  return { epochs, advance };
}

export function makeRefGenerations(capacity: number) {
  const generations = new Map<string, number>();
  let sequence = 0;
  const set = (cwd: string, generation: number) => {
    generations.delete(cwd);
    generations.set(cwd, generation);
    if (generations.size > capacity) {
      const oldest = generations.keys().next().value;
      if (oldest !== undefined) generations.delete(oldest);
    }
    return generation;
  };
  return {
    current: (cwd: string) => set(cwd, generations.get(cwd) ?? ++sequence),
    bump: (cwd: string) => set(cwd, ++sequence),
  };
}
