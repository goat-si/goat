import * as Schema from "effect/Schema";
import { EnvironmentId, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const canonicalHttpOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
};

export const BrowserOrigin = Schema.String.check(
  Schema.makeFilter((value) => canonicalHttpOrigin(value) || "Expected a canonical HTTP origin."),
);
export type BrowserOrigin = typeof BrowserOrigin.Type;

export const LiveTabRef = Schema.Struct({
  pid: PositiveInt,
  windowId: PositiveInt,
  tabId: TrimmedNonEmptyString,
});
export type LiveTabRef = typeof LiveTabRef.Type;

export const BrowserOriginGrant = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  origin: BrowserOrigin,
});
export type BrowserOriginGrant = typeof BrowserOriginGrant.Type;

export const PendingBrowserBind = Schema.Struct({
  claimId: TrimmedNonEmptyString,
  pid: PositiveInt,
  windowId: PositiveInt,
  origin: BrowserOrigin,
});
export type PendingBrowserBind = typeof PendingBrowserBind.Type;

export const BrowserClaimEndReason = Schema.Literals([
  "revoked",
  "stopped",
  "driver_restarted",
  "origin_changed",
  "origin_mismatch",
  "refused",
  "tab_closed",
]);
export const LiveTabClaim = Schema.Struct({
  claimId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  tab: LiveTabRef,
  title: Schema.String,
  origin: BrowserOrigin,
  driverGeneration: PositiveInt,
  claimGeneration: PositiveInt,
  status: Schema.Literal("attached"),
});
export type LiveTabClaim = typeof LiveTabClaim.Type;

export const BrowserClaimRequestInput = Schema.Struct({
  threadId: ThreadId,
  pid: PositiveInt,
  windowId: PositiveInt,
  origin: BrowserOrigin,
});
export const BrowserClaimAnswerInput = Schema.Struct({
  claimId: TrimmedNonEmptyString,
  approved: Schema.Boolean,
});
export const BrowserClaimEndInput = Schema.Struct({ claimId: TrimmedNonEmptyString });
export const BrowserGrantRevokeInput = Schema.Struct({ threadId: ThreadId, origin: BrowserOrigin });
export const BrowserClaimsListInput = Schema.Struct({ threadId: ThreadId });
export const BrowserClaimResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending"), claimId: TrimmedNonEmptyString }),
  Schema.Struct({ status: Schema.Literal("attached"), claim: LiveTabClaim }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    code: TrimmedNonEmptyString,
    message: Schema.String,
  }),
]);
export const BrowserClaimsSnapshot = Schema.Struct({
  claims: Schema.Array(LiveTabClaim),
  grants: Schema.Array(BrowserOriginGrant),
});
