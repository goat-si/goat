import * as Schema from "effect/Schema";

import type { ApprovalChoiceOrder } from "./channelApprovalCards.ts";

/** An approval card's code and the order its card lists Deny and Approve in. */
export interface IssuedApprovalCode {
  readonly code: string;
  readonly order: ApprovalChoiceOrder;
}

// `order` arrived when cards moved Deny first; a record without it was issued Approve first.
const ApprovalCodeOf = Schema.fromJsonString(
  Schema.Struct({ code: Schema.String, order: Schema.optional(Schema.Literal("deny-first")) }),
);
const encode = Schema.encodeSync(ApprovalCodeOf);
const decode = Schema.decodeUnknownSync(ApprovalCodeOf);

/** A code issued now, with the stored record that keeps the order its card is sent in. */
export const newApprovalCode = (code: string) => {
  const issued: IssuedApprovalCode = { code, order: "deny-first" };
  return { issued, json: encode({ code, order: "deny-first" }) };
};

export const readApprovalCode = (json: string): IssuedApprovalCode => {
  const record = decode(json);
  return { code: record.code, order: record.order ?? "approve-first" };
};
