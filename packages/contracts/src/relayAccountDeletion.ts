import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const RelayAccountDeletionProgress = Schema.Struct({
  status: Schema.Literal("progress"),
  operationId: Schema.String,
  relayState: Schema.Literals(["erasing", "erased"]),
  step: Schema.Literals([
    "relay_denied",
    "hooks_cleared",
    "owned_rows_erased",
    "relay_erasure_completed",
  ]),
  relayDenied: Schema.Literal(true),
  hostCleanup: Schema.Struct({ pending: Count, acknowledged: Count, unsupported: Count }),
  endpointCleanup: Schema.Literals(["pending", "no_matches_observed"]),
  identityAction: Schema.Literals(["delete_clerk_user", "already_deleted"]),
  retryAfterSeconds: Schema.optionalKey(Count),
  lastErrorCode: Schema.optionalKey(Schema.String),
  traceId: Schema.String,
});
export const RelayAccountDeletionTerminal = Schema.Struct({
  status: Schema.Literal("deleted"),
  deletedAt: Schema.String,
});
export const RelayAccountDeletion = Schema.Union([
  RelayAccountDeletionProgress,
  RelayAccountDeletionTerminal,
]);
export type RelayAccountDeletion = typeof RelayAccountDeletion.Type;
export const RelayAccountDeletionStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("absent") }),
  RelayAccountDeletion,
]);
export type RelayAccountDeletionStatus = typeof RelayAccountDeletionStatus.Type;
export const RelayAccountDeletionAccepted = Schema.Struct({
  ...RelayAccountDeletionProgress.fields,
  relayState: Schema.Literal("erasing"),
}).pipe(HttpApiSchema.status(202));
export const RelayAccountDeletionCompleted = Schema.Struct({
  ...RelayAccountDeletionProgress.fields,
  relayState: Schema.Literal("erased"),
});
export const RelayHostRevocationRequest = Schema.Struct({
  environmentPublicKey: Schema.String,
  proof: Schema.String,
});
export const RelayHostRevocationAckRequest = Schema.Struct({
  environmentPublicKey: Schema.String,
  proof: Schema.String,
  revocationId: Schema.String,
});
export const RelayHostRevocationReceipt = Schema.Struct({
  revocationId: Schema.String,
  reason: Schema.Literal("account_deleted"),
  action: Schema.Literal("unlink"),
});
export const RelayHostRevocationProof = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  action: Schema.Literals(["unlink", "ack"]),
  path: Schema.String,
  credentialDigest: Schema.String,
  revocationId: Schema.optionalKey(Schema.String),
  jti: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
});
