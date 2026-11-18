import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const probeFingerprint = Effect.fn("AcpRegistry.probeFingerprint")(function* (
  environment: NodeJS.ProcessEnv,
  spawn: AcpSessionRuntime.AcpSpawnInput,
) {
  const digest = yield* Digest.Digest;
  const json = yield* encode({
    environment: Object.entries(environment).toSorted(([a], [b]) => a.localeCompare(b)),
    spawn,
  }).pipe(Effect.orDie);
  return Hex.encode(
    yield* digest.digest(Digest.sha256, new TextEncoder().encode(json)).pipe(Effect.orDie),
  );
});
