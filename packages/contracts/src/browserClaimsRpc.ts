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
  browserClaimsWindows: "browserClaims.windows",
  browserClaimsClaim: "browserClaims.claim",
  browserClaimsAnswer: "browserClaims.answer",
  browserClaimsRevoke: "browserClaims.revoke",
  browserClaimsEnd: "browserClaims.end",
  browserClaimsList: "browserClaims.list",
  browserClaimsSubscribe: "browserClaims.subscribe",
} as const;

export class BrowserClaimsRpcError extends Schema.TaggedError<BrowserClaimsRpcError>()(
  "BrowserClaimsRpcError",
  { message: Schema.String },
) {}
const errors = Schema.Union([BrowserClaimsRpcError, EnvironmentAuthorizationError]);
export const BrowserClaimsPersonSnapshot = Schema.Struct({
  claims: Schema.Array(
    Schema.Struct({ ...LiveTabClaim.fields, windowTitle: Schema.optionalKey(Schema.String) }),
  ),
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
export const BrowserClaimWindows = Schema.Struct({
  windows: Schema.Array(
    Schema.Struct({
      pid: PositiveInt,
      windowId: PositiveInt,
      title: Schema.String,
      app: Schema.String,
    }),
  ),
  refused: Schema.Array(
    Schema.Struct({
      pid: PositiveInt,
      app: Schema.String,
      reason: Schema.Literals(["browser_process_protected", "outside_manifest"]),
    }),
  ),
});
export const BrowserClaimsRpcs = RpcGroup.make(
  Rpc.make(BROWSER_CLAIMS_WS_METHODS.browserClaimsWindows, {
    payload: Schema.Struct({}),
    success: BrowserClaimWindows,
    error: errors,
  }),
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
  Rpc.make(BROWSER_CLAIMS_WS_METHODS.browserClaimsSubscribe, {
    payload: Schema.Struct({}),
    success: BrowserClaimsPersonSnapshot,
    error: errors,
    stream: true,
  }),
);
