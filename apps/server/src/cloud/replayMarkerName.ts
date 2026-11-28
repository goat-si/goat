import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";

export const makeReplayMarkerName = Effect.map(Digest.Digest, (digest) =>
  Effect.fnUntraced(function* (prefix: string, value: string) {
    const hash = yield* digest
      .digest(Digest.sha256, new TextEncoder().encode(value))
      .pipe(Effect.orDie);
    return `${prefix}${Hex.encode(hash)}`;
  }),
);
