import * as Effect from "effect/Effect";

// Each chunk belongs to the enclosing snapshot span.
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
