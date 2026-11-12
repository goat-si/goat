// A small seeded PRNG (mulberry32) so fuzzing and differential runs repeat exactly.
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    /** An integer in [0, n). */
    int: (n: number) => Math.floor(next() * n),
    bytes: (n: number) => Uint8Array.from({ length: n }, () => Math.floor(next() * 256)),
  };
}
