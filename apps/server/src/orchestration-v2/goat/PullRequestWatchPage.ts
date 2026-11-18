import * as Arr from "effect/Array";

const WATCH_SWEEP_BUDGET = 64;

type Work = { readonly key: string; readonly size: number };

export const splitWatchGroup = Arr.chunksOf(WATCH_SWEEP_BUDGET);

export const watchSweepPage = <Item extends Work>(work: ReadonlyArray<Item>, after?: string) => {
  const sorted = work.toSorted((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  const start = after === undefined ? 0 : sorted.findIndex(({ key }) => key > after);
  // If the remainder disappeared between passes, start the next cycle now.
  let index = Math.max(start, 0);
  let remaining = WATCH_SWEEP_BUDGET;
  const items: Array<Item> = [];
  for (let item = sorted[index]; item !== undefined; item = sorted[++index]) {
    if (item.size > remaining) return { items, after: items.at(-1)?.key };
    items.push(item);
    remaining -= item.size;
  }
  return { items, after: undefined };
};
