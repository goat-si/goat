import { TrimmedNonEmptyString } from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ProcessRunner from "../processRunner.ts";

const LocalCredentials = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  generation: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
/** Only the additive attestation OpenCodex publishes; other status fields are ignored. */
const LocalCredentialStatus = Schema.Struct({
  runtimeRole: Schema.Literals(["standalone", "hub", "client"]),
  localCredentials: Schema.optional(LocalCredentials),
});
export type LocalCredentialStatus = typeof LocalCredentialStatus.Type;
const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(LocalCredentialStatus));

/**
 * The selected Child ocx's own count of credentials stored on this machine, read fresh from
 * `ocx status --json`. Home-projected accounts never count; GOAT reads no credential files. None
 * when the status cannot be read or decoded.
 */
export const readLocalCredentials = Effect.fn("OpenCodexLocalAccounts.read")(function* (
  runner: ProcessRunner.ProcessRunner["Service"],
  binary: string,
  env: NodeJS.ProcessEnv,
) {
  const output = yield* runner
    .run({
      command: binary,
      args: ["status", "--json"],
      env,
      stdin: "",
      timeout: "10 seconds",
      maxOutputBytes: 1024 * 1024,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (
    Option.isNone(output) ||
    output.value.code !== 0 ||
    output.value.timedOut ||
    output.value.stdoutTruncated ||
    output.value.stdoutInvalidUtf8
  )
    return Option.none<LocalCredentialStatus>();
  return decodeStatus(output.value.stdout);
});

const encodeAttestation = Schema.encodeSync(Schema.fromJsonString(LocalCredentials));

/** A digest of the nonsecret zero-count attestation; never of any credential value. */
export const localAccountsDigest = Effect.fn("OpenCodexLocalAccounts.digest")(function* (
  crypto: Crypto.Crypto,
  generation: string,
) {
  const bytes = new TextEncoder().encode(encodeAttestation({ count: 0, generation }));
  return Hex.encode(yield* crypto.digest("SHA-256", bytes));
});
