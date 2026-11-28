import * as Effect from "effect/Effect";

// Each chunk belongs to the enclosing snapshot span.
export const reduceShellChunks = Effect.fnUntraced(function* <A, B>(
  rows: ReadonlyArray<A>,
  result: B,
  add: (result: B, row: A) => void,
) {
  for (let index = 0; index < rows.length; index++) {
    if (index > 0 && index % 250 === 0) yield* Effect.yieldNow;
    const row = rows[index];
    if (row !== undefined) add(result, row);
  }
  return result;
});

export const mapShellChunks = Effect.fnUntraced(function* <A, B, E, R>(
  rows: ReadonlyArray<A>,
  map: (row: A) => Effect.Effect<B, E, R>,
) {
  const results: Array<B> = [];
  for (let start = 0; start < rows.length; start += 250) {
    if (start > 0) yield* Effect.yieldNow;
    results.push(...(yield* Effect.forEach(rows.slice(start, start + 250), map)));
  }
  return results;
});

export const partitionShells = Effect.fnUntraced(function* <
  A extends { readonly archivedAt: unknown },
>(rows: ReadonlyArray<A>) {
  return yield* reduceShellChunks(
    rows,
    { threads: Array<A>(), archivedThreads: Array<A>() },
    (result, row) => {
      (row.archivedAt === null ? result.threads : result.archivedThreads).push(row);
    },
  );
});
