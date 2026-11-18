const WATCH_SWEEP_BUDGET = 64;

export const watchSweepPage = <Item extends { readonly key: string }>(
  work: ReadonlyArray<Item>,
  after?: string,
) => {
  const sorted = work.toSorted((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  // If the remainder disappeared between passes, start the next cycle now.
  const start =
    after === undefined
      ? 0
      : Math.max(
          0,
          sorted.findIndex(({ key }) => key > after),
        );
  const end = start + WATCH_SWEEP_BUDGET;
  const items = sorted.slice(start, end);
  return { items, after: end < sorted.length ? items.at(-1)?.key : undefined };
};
