import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { OcxOutput } from "../HubOcx.ts";

/**
 * Removing a disposable machine's OpenCodex link (design section 3): a journalled purge revoke, a
 * forced revoke that leaves a tombstone when the machine does not answer, and recover once it
 * does. Kept in enroll_json; every value is GOAT's own fixed code.
 */
export const Detach = Schema.Struct({
  /** settle (read a link operation first), revoke, recover, or done. */
  step: Schema.String,
  /** Revokes started; each has its own id, <attachId>.<purge|force>.<attempt>. */
  attempt: Schema.Number,
  operationId: Schema.optionalKey(Schema.String),
  /** How many times the current id was sent; OpenCodex asks for a repeat of an unsettled revoke. */
  sends: Schema.optionalKey(Schema.Number),
  /** When the last revoke or recover ran, for the wait between tries of a silent machine. */
  triedAtMs: Schema.optionalKey(Schema.Number),
  /** A person asked to remove the link without the machine. */
  force: Schema.optionalKey(Schema.Literal(true)),
  outcome: Schema.optionalKey(Schema.String),
  /** When the settle step first saw no enrollment step running, for its quiet wait. */
  idleSinceMs: Schema.optionalKey(Schema.Number),
  /** Why the detach waits for a person (a Child's refusal or an unsettled revoke). */
  stop: Schema.optionalKey(Schema.String),
});
export type Detach = typeof Detach.Type;

/** The handshake of a linked or detaching machine (design section 3, Retirement). */
export const Health = Schema.Struct({
  failures: Schema.Number,
  firstFailureAtMs: Schema.optionalKey(Schema.Number),
  checkedAtMs: Schema.Number,
});
export type Health = typeof Health.Type;

export const CHECK_EVERY_MS = 30 * 60 * 1000;
const RETIRE_FAILURES = 48;
const RETIRE_SPAN_MS = 24 * 60 * 60 * 1000;
export const REVOKE_SENDS = 3;

/** Whether 48 failed handshakes over at least 24 hours retire the machine. */
export const retires = (health: Health | undefined, nowMs: number) =>
  health !== undefined &&
  health.failures >= RETIRE_FAILURES &&
  health.firstFailureAtMs !== undefined &&
  nowMs - health.firstFailureAtMs >= RETIRE_SPAN_MS;

export const revokeOperationId = (attachId: string, mode: "purge" | "force", attempt: number) =>
  attachId + "." + mode + "." + String(attempt);

const LINK_ID = /^lnk_[0-9a-f]{16}$/u;
const CODE = /^[a-z_]{1,40}$/u;
const RevokeEntry = Schema.Struct({
  operationId: Schema.String,
  kind: Schema.String,
  state: Schema.String,
  linkId: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String })),
  receipt: Schema.optionalKey(Schema.Struct({ purged: Schema.Boolean, linkId: Schema.String })),
});
const decodeRevokeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(RevokeEntry));

/** What OpenCodex's journal says of a revoke; a purge is clean only with the Child's receipt. */
export type RevokeOutcome =
  | { readonly kind: "clean" }
  | { readonly kind: "failed_clean"; readonly code: string }
  | { readonly kind: "open" }
  | { readonly kind: "unsettled"; readonly state: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "unreadable" };

export const readRevoke = (
  output: OcxOutput | undefined,
  expected: { readonly operationId: string; readonly linkId: string; readonly force: boolean },
): RevokeOutcome => {
  if (output === undefined) return { kind: "unreadable" };
  // Not journalled: the revoke never reached the Home's journal, so trying again is safe.
  if (output.code === 4) return { kind: "not_found" };
  if (output.code !== 0) return { kind: "unreadable" };
  const entry = Option.getOrUndefined(decodeRevokeEntry(output.stdout));
  if (
    entry === undefined ||
    entry.operationId !== expected.operationId ||
    entry.kind !== "revoke" ||
    entry.linkId !== expected.linkId
  )
    return { kind: "unreadable" };
  switch (entry.state) {
    case "committed":
      return expected.force ||
        (entry.receipt?.purged === true && entry.receipt.linkId === expected.linkId)
        ? { kind: "clean" }
        : { kind: "unsettled", state: "unproven" };
    case "failed_clean": {
      const code = entry.error?.code;
      return {
        kind: "failed_clean",
        code: code !== undefined && CODE.test(code) ? code : "failed",
      };
    }
    case "open":
      return { kind: "open" };
    case "residual":
    case "unknown":
      return { kind: "unsettled", state: entry.state };
    default:
      return { kind: "unreadable" };
  }
};

/** Hints of a refused purge that need a person's look at the Child; any other one is unreachable. */
export const CHILD_REFUSALS: ReadonlySet<string> = new Set([
  "child_residual",
  "child_link_mismatch",
  "child_disconnect_pending",
  "expect_link_unsupported",
  "binary_in_use",
]);

const RecoverReceipt = Schema.Struct({
  linkId: Schema.String,
  outcome: Schema.Literal("clean"),
  purged: Schema.Boolean,
});
const decodeRecover = Schema.decodeUnknownOption(Schema.fromJsonString(RecoverReceipt));

/** What ocx link recover answered: clean, or the refusal's code, or nothing readable. */
export const recoverAnswer = (output: OcxOutput | undefined, linkId: string) => {
  if (output === undefined) return "unreadable";
  if (output.code === 0) {
    const receipt = Option.getOrUndefined(decodeRecover(output.stdout));
    return receipt?.linkId === linkId && LINK_ID.test(linkId) ? "clean" : "unreadable";
  }
  const code = output.refusal?.code;
  return code !== undefined && CODE.test(code) ? code : "unreadable";
};

const StatusLinks = Schema.Struct({
  links: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      explicitRoute: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ identityFile: Schema.optionalKey(Schema.String) })),
      ),
    }),
  ),
});
const decodeStatusLinks = Schema.decodeUnknownOption(Schema.fromJsonString(StatusLinks));

/**
 * Whether the link's route still names the current machine key file: "moved" after GOAT's home
 * moved under a linked machine, "same" otherwise, "unknown" when the status cannot say.
 */
export const linkKeyState = (output: OcxOutput | undefined, linkId: string, keyFile: string) => {
  if (output === undefined || output.code !== 0) return "unknown" as const;
  const status = Option.getOrUndefined(decodeStatusLinks(output.stdout));
  const identity = status?.links.find((link) => link.id === linkId)?.explicitRoute?.identityFile;
  if (identity === undefined) return "unknown" as const;
  return identity === keyFile ? ("same" as const) : ("moved" as const);
};
