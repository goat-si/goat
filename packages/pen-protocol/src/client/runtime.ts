import { PenError } from "./errors.ts";

/** Platform CSPRNG: returns exactly `length` random bytes or throws. Injected so tests are deterministic. */
export type Random = (length: number) => Uint8Array;

export interface Timer {
  cancel(): void;
}

/** Time source and timers, injected so tests drive time by hand. */
export interface Clock {
  now(): number;
  setTimer(ms: number, fn: () => void): Timer;
}

/** Bytes from the CSPRNG; a throw or a short answer refuses the operation that needed them. */
export function takeRandom(random: Random, length: number): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = random(length);
  } catch (cause) {
    throw new PenError("random-unavailable", "the platform random source failed", { cause });
  }
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new PenError(
      "random-unavailable",
      "the platform random source returned the wrong length",
    );
  }
  return bytes.slice();
}
