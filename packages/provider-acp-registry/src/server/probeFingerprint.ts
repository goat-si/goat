import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const probeFingerprint = Effect.fn("AcpRegistry.probeFingerprint")(function* (
  environment: NodeJS.ProcessEnv,
  spawn: AcpSessionRuntime.AcpSpawnInput,
) {
  const crypto = yield* Crypto.Crypto;
  const json = yield* encode({
    environment: Object.entries(environment).toSorted(([a], [b]) => a.localeCompare(b)),
    spawn,
  }).pipe(Effect.orDie);
  return Hex.encode(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(json)).pipe(Effect.orDie),
  );
});
