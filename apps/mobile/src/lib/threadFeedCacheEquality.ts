export function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

export function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key) || right.get(key) !== value) return false;
  }
  return true;
}

export function setMapsEqual<K, V>(
  left: ReadonlyMap<K, ReadonlySet<V>>,
  right: ReadonlyMap<K, ReadonlySet<V>>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, values] of left) {
    const other = right.get(key);
    if (other === undefined || !setsEqual(values, other)) return false;
  }
  return true;
}

/** Index of the first entry that differs, or the shorter length when one extends the other. */
export function firstChangedIndex<T>(previous: ReadonlyArray<T>, next: ReadonlyArray<T>): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit && previous[index] === next[index]) index += 1;
  return index;
}
