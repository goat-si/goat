import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  BrowserClaimAnswerInput,
  BrowserClaimEndInput,
  BrowserClaimRequestInput,
  BrowserClaimResult,
  BrowserGrantRevokeInput,
  BrowserOrigin,
  BrowserOriginGrant,
  LiveTabClaim,
} from "./browserClaims.ts";

export const BROWSER_CLAIMS_WS_METHODS = {
  browserClaimsClaim: "browserClaims.claim",
  browserClaimsAnswer: "browserClaims.answer",
  browserClaimsRevoke: "browserClaims.revoke",
  browserClaimsEnd: "browserClaims.end",
  browserClaimsList: "browserClaims.list",
} as const;

export class BrowserClaimsRpcError extends Schema.TaggedError<BrowserClaimsRpcError>()(
  "BrowserClaimsRpcError",
  { message: Schema.String },
) {}
const errors = Schema.Union([BrowserClaimsRpcError, EnvironmentAuthorizationError]);
export const BrowserClaimsPersonSnapshot = Schema.Struct({
  claims: Schema.Array(LiveTabClaim),
  grants: Schema.Array(BrowserOriginGrant),
  pending: Schema.Array(
    Schema.Struct({
      claimId: TrimmedNonEmptyString,
      threadId: ThreadId,
      pid: PositiveInt,
      windowId: PositiveInt,
      origin: BrowserOrigin,
      windowTitle: Schema.String,
      createdAt: NonNegativeInt,
    }),
  ),
});
const answer = Schema.Struct({
  agentResult: BrowserClaimResult,
  personMessage: Schema.optionalKey(Schema.String),
});
export const BrowserClaimsRpcs = RpcGroup.make(
  Rpc.make(BROWSER_CLAIMS_WS_METHODS.browserClaimsClaim, {
    payload: BrowserClaimRequestInput,
    success: answer,
    error: errors,
  }),
  Rpc.make(BROWSER_CLAIMS_WS_METHODS.browserClaimsAnswer, {
    payload: BrowserClaimAnswerInput,
    success: answer,
    error: errors,
  }),
  Rpc.make(BROWSER_CLAIMS_WS_METHODS.browserClaimsRevoke, {
    payload: BrowserGrantRevokeInput,
    success: Schema.Void,
    error: errors,
  }),
  Rpc.make(BROWSER_CLAIMS_WS_METHODS.browserClaimsEnd, {
    payload: BrowserClaimEndInput,
    success: Schema.Boolean,
    error: errors,
  }),
  Rpc.make(BROWSER_CLAIMS_WS_METHODS.browserClaimsList, {
    payload: Schema.Struct({}),
    success: BrowserClaimsPersonSnapshot,
    error: errors,
  }),
);
