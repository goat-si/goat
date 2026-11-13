// @effect-diagnostics-next-line nodeBuiltinImport:off -- request keys.
import * as NodeCrypto from "node:crypto";

import {
  HubMachinesError,
  type HubMachinesErrorReason,
  type HubMachineStatus,
  type ServerSettings,
  ThreadId,
} from "@goat/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import {
  type AttachEffect,
  conflictCount,
  decodeEffects,
  decodeProvisioner,
  mintSteps,
  type StoredProvisioner,
  stateMessage,
} from "./attachModel.ts";
import type * as Store from "./DisposableMachineStore.ts";
import { decodeEnroll, enrollMessage, enrollSteps, leftPenMessage } from "./enrollModel.ts";
import type { PenInviteRef } from "./PenInvites.ts";

/** A disposable_machines row, the SQL that selects records by phase, and the fixed refusals. */
export const OPEN = "final_at IS NULL AND state NOT IN ('failed', 'purged', 'destroyed', 'kept')";
export const IN_PEN = "pen_admitted_at IS NOT NULL AND pen_removed_at IS NULL";
// A final record still owes Pen an ack for a terminal entry GOAT stored.
export const OWES_ACK = `EXISTS (SELECT 1 FROM json_each(effects_json)
  WHERE json_extract(value, '$.settled') IN ('cancelled', 'expired', 'burned')
    AND json_extract(value, '$.acked') IS NULL)`;

export interface Row {
  readonly attach_id: string;
  readonly name: string;
  readonly node_id: string;
  readonly expected_sign_pub: string;
  readonly expected_noise_pub: string;
  readonly provisioner_json: string;
  readonly delegation_json: string;
  readonly grant_id: string;
  readonly invite_expires_at: string | null;
  readonly state: string;
  readonly step: string | null;
  readonly fence: number;
  readonly effects_json: string;
  readonly conflicts_json: string;
  readonly route_json: string | null;
  readonly link_operation_id: string | null;
  readonly link_id: string | null;
  readonly enroll_json: string;
  readonly request_key: string | null;
  readonly state_since: string;
  readonly pen_admitted_at: string | null;
  readonly pen_removed_at: string | null;
  readonly final_at: string | null;
}
export type Columns = Record<string, string | number | null>;
export type Refusal =
  | "conflict"
  | "switch_off"
  | "switch_expired"
  | "provisioner_refused"
  | "delegation_lost";

export const fail = (reason: HubMachinesErrorReason, detail: string) =>
  Effect.fail(new HubMachinesError({ reason, detail }));
export const storageFailed = () =>
  new HubMachinesError({
    reason: "storage_failed",
    detail: "The hub's disposable machine records are unavailable.",
  });
export const digest = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
export const effectsOf = (row: Row) => decodeEffects(row.effects_json);
export const provisionerOf = (row: Row) => decodeProvisioner(row.provisioner_json);
export const sameProvisioner = (a: StoredProvisioner | undefined, b: StoredProvisioner) =>
  a !== undefined &&
  (a.kind === "thread" ? b.kind === "thread" && a.threadId === b.threadId : b.kind === "person");
export const isCanonicalKey = (key: string) => {
  const bytes = Buffer.from(key, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === key;
};
export const replace = (effects: ReadonlyArray<AttachEffect>, next: AttachEffect) =>
  effects.map((effect) => (effect.id === next.id ? next : effect));
/** A cancel's answer settles the mint only when it names a terminal state without a burn. */
export const afterCancel = (effect: AttachEffect, answer: string): AttachEffect =>
  answer === "cancelled" || answer === "expired" ? { ...effect, settled: answer } : effect;
export const refusalText: Record<Refusal, string> = {
  conflict: "The record changed while the invite was being made.",
  switch_off: "Attach disposable machines no longer allows this attach.",
  switch_expired: "Attach disposable machines has expired on this hub.",
  provisioner_refused: "This thread is not named in Attach disposable machines.",
  delegation_lost: "The provisioner no longer holds the grant this attach started with.",
};
export const refusalOf = (reason: Store.ForwardRefusal | "provisioner_refused"): Refusal =>
  reason === "switch_expired" || reason === "provisioner_refused"
    ? reason
    : reason === "fence_moved" || reason === "not_found"
      ? "conflict"
      : "switch_off";
/** The forward commit found the provisioner no longer named; failing the write rolls it back. */
export class NotNamed extends Data.TaggedError("NotNamed")<{}> {}
/** Pen is asked by invite id once GOAT knows it, so a lost entry never reads as a fresh fence. */
export const refOf = (effect: AttachEffect): PenInviteRef =>
  effect.inviteId === undefined ? { mintId: effect.id } : { inviteId: effect.inviteId };
// Every settings writer waits while a transaction holds the lock, so each is bounded as the store's is.
export const lockBound = Effect.timeoutOrElse({
  duration: "15 seconds",
  orElse: () => Effect.fail(storageFailed()),
});
/** The goatclaw policy a grant was resolved from is the one in force. */
export const samePolicy = (a: ServerSettings, b: ServerSettings) =>
  JSON.stringify(a.goatclaw) === JSON.stringify(b.goatclaw);

export const status = (
  row: Row,
  invite?: { readonly token: string; readonly expiresAt: string },
  machineKey?: string,
): HubMachineStatus => {
  const enroll = decodeEnroll(row.enroll_json);
  const leftWithLink =
    row.pen_removed_at !== null && (row.link_id !== null || row.link_operation_id !== null);
  const { message, nextAction } =
    (leftWithLink
      ? leftPenMessage(row.name, row.final_at !== null, row.link_id, row.link_operation_id)
      : undefined) ??
    (row.pen_admitted_at === null
      ? undefined
      : enrollMessage(row.state, row.name, enroll, row.pen_admitted_at < row.state_since)) ??
    stateMessage(row.state, row.name, row.pen_removed_at !== null, row.pen_admitted_at !== null);
  const provisioner = provisionerOf(row);
  return {
    attachId: row.attach_id,
    name: row.name,
    nodeId: row.node_id,
    state: row.state,
    step: row.step,
    // The wire carries 32 steps; reissue stops there, and an older row shows its latest.
    steps: [...mintSteps(effectsOf(row)), ...enrollSteps(enroll)].slice(-32),
    message,
    nextAction,
    class:
      row.final_at !== null
        ? "kept"
        : conflictCount(row.conflicts_json) > 0
          ? "conflict"
          : "disposable",
    penMember: row.pen_admitted_at !== null && row.pen_removed_at === null,
    provisioner:
      provisioner?.kind === "thread"
        ? { kind: "thread", threadId: ThreadId.make(provisioner.threadId) }
        : { kind: "person" },
    stateSince: row.state_since,
    ...(machineKey === undefined || row.final_at !== null ? {} : { machineKey }),
    ...(invite === undefined ? {} : { invite }),
  };
};
