import { CommandId, NonNegativeInt, TrimmedNonEmptyString } from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest keeps the key pure.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

import type { PlacementKey } from "./PlacementReservations.ts";

/**
 * Off on every machine until the integrated mesh-link review enables it. Off, a target refuses a
 * placement and does not declare it, and placers never send one.
 */
export const PlacementAdmissionEnabled = Context.Reference<boolean>(
  "goat/fleet/admission/PlacementAdmissionEnabled",
  { defaultValue: () => false },
);

/** What a placer sends with goat_thread_launch; the target adds the placer from the session. */
export const PlacementArgument = Schema.Struct({
  ownerKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  attempt: NonNegativeInt.check(Schema.isLessThanOrEqualTo(2_147_483_647)),
  /** ISO-8601 UTC, set once when the placer creates the attempt and reused by every retry. */
  issuedAt: Schema.String,
});
export type PlacementArgument = typeof PlacementArgument.Type;

/** Milliseconds, or undefined when issuedAt is not an ISO-8601 instant. */
export const issuedAtMillis = (issuedAt: string): number | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(issuedAt)) return undefined;
  const millis = Date.parse(issuedAt);
  return Number.isFinite(millis) ? millis : undefined;
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The launch's command id, and with it the thread id, follow from the key alone. */
export const placementCommandId = (key: PlacementKey): CommandId =>
  CommandId.make(
    "placement:" +
      NodeCrypto.createHash("sha256")
        .update(encodeJson([key.placer, key.ownerKey, key.attempt, key.issuedAt]))
        .digest("hex"),
  );

export const initialMessageCommandId = (commandId: CommandId): CommandId =>
  CommandId.make(commandId + ":initial-message");

/**
 * With admission off, goat_thread_launch does not declare placement, so a placer's check of the
 * declared arguments refuses this machine and a call that sends one is refused as undeclared.
 */
export const hidePlacementArgument = <S extends { readonly properties?: object | undefined }>(
  toolName: string,
  inputSchema: S,
  declared: boolean,
): S => {
  if (declared || toolName !== "goat_thread_launch" || inputSchema.properties === undefined)
    return inputSchema;
  const { placement: _placement, ...properties } = inputSchema.properties as Record<
    string,
    unknown
  >;
  return { ...inputSchema, properties };
};
