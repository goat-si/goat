// @effect-diagnostics-next-line nodeBuiltinImport:off -- node ids are a digest of the signing key, as Pen derives them.
import * as NodeCrypto from "node:crypto";

import { type HubMachineStatus, type HubMachineStep, RuntimeMode } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PenInviteStatus } from "./PenInvites.ts";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Pen's node id for a signing key: lowercase base32 without padding of the first 16 bytes of
 * SHA-256(signPub) (pen-protocol CONTRACT "Identities"). Undefined for a key that is not 32 bytes.
 */
export const penNodeId = (signPub: string) => {
  const key = Buffer.from(signPub, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== signPub) return undefined;
  const bytes = NodeCrypto.createHash("sha256").update(key).digest().subarray(0, 16);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
};

/**
 * One mint an attach started, named by its mintId, with what Pen last said about it. An effect is
 * settled once Pen reports a terminal state for that mintId; the record holds its slot until every
 * effect is settled or its key is admitted.
 */
const AttachEffect = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("mint"),
  /** What the dispatch returned: intent (none yet), done (token returned), unknown, late. */
  state: Schema.Literals(["intent", "done", "unknown", "late"]),
  inviteId: Schema.optionalKey(Schema.String),
  /** The absolute expiry GOAT sent with the mint; after it, Pen can no longer create that invite. */
  expiresAtMs: Schema.Number,
  /** Withdrawal was decided: GOAT cancels this mintId until Pen reports a terminal state. */
  withdrawn: Schema.optionalKey(Schema.Literal(true)),
  /** Pen's last non-terminal answer, which can keep the record unknown. */
  seen: Schema.optionalKey(
    Schema.Literals(["live", "burned-unsaved", "burned-without-admit", "absent"]),
  ),
  /** Pen's terminal state for this mintId, stored before GOAT acknowledges it. */
  settled: Schema.optionalKey(Schema.Literals(["cancelled", "expired", "burned", "absent"])),
  /** Pen forgot the terminal entry or fence after GOAT stored it. */
  acked: Schema.optionalKey(Schema.Literal(true)),
});
export type AttachEffect = typeof AttachEffect.Type;
const EffectsJson = Schema.fromJsonString(Schema.Array(AttachEffect));
/** A record's effects; an unreadable list reads as none started, which keeps nothing settled. */
const decodeEffectsJson = Schema.decodeOption(EffectsJson);
export const decodeEffects = (json: string): ReadonlyArray<AttachEffect> =>
  Option.getOrElse(decodeEffectsJson(json), () => []);
export const encodeEffects = Schema.encodeSync(EffectsJson);

/**
 * What one answer of invite.status or invite.cancel for this mintId changes. A mint Pen never saw is
 * final only once its absolute expiry has passed, since Pen refuses a create after it; an invite
 * GOAT knows was made and Pen no longer has stays open, holding the slot.
 */
export const observe = (
  known: AttachEffect,
  answer: PenInviteStatus,
  nowMs: number,
): AttachEffect => {
  // Once Pen names the invite a mint made, GOAT asks by that id from then on.
  const effect =
    known.inviteId === undefined && answer.inviteId !== undefined
      ? { ...known, inviteId: answer.inviteId }
      : known;
  switch (answer.state) {
    case "cancelled":
    case "expired":
      return { ...effect, settled: answer.state };
    case "burned":
      return answer.admit === undefined
        ? { ...effect, seen: "burned-without-admit" }
        : { ...effect, settled: "burned" };
    case "live":
    case "burned-unsaved":
      return { ...effect, seen: answer.state };
    case "absent":
      return effect.inviteId === undefined && effect.state !== "done" && nowMs > effect.expiresAtMs
        ? { ...effect, settled: "absent" }
        : { ...effect, seen: "absent" };
  }
};

/**
 * Whether Pen may now forget this mint's entry: GOAT has stored its terminal state, and a fence
 * (a cancel of a mintId Pen had not seen) outlives the mint's expiry, after which the expiry alone
 * refuses a late create.
 */
export const ackable = (effect: AttachEffect, nowMs: number) =>
  effect.acked !== true &&
  effect.settled !== undefined &&
  effect.settled !== "absent" &&
  (effect.inviteId !== undefined || nowMs > effect.expiresAtMs);

export const openEffects = (effects: ReadonlyArray<AttachEffect>) =>
  effects.filter((effect) => effect.settled === undefined);

/**
 * A record's state from its mints, before admission: failed once every mint is settled without a
 * burn, unknown while a burn has no saved admit or a dispatch has no receipt, paused once withdrawn,
 * invited while its one open mint returned a token Pen still holds live.
 */
export const stateFromEffects = (effects: ReadonlyArray<AttachEffect>) => {
  const open = openEffects(effects);
  if (open.length === 0) return "failed" as const;
  if (open.some((effect) => effect.seen === "burned-without-admit")) return "unknown" as const;
  if (open.some((effect) => effect.withdrawn === true)) return "paused" as const;
  const [only] = open;
  return open.length === 1 && only?.state === "done" && (only.seen ?? "live") === "live"
    ? ("invited" as const)
    : ("unknown" as const);
};

/** Who asks, as stored: a thread the switch names, or a person's session. */
const StoredProvisioner = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadId: Schema.String,
    cloudRunId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("person"), sessionId: Schema.String }),
]);
export type StoredProvisioner = typeof StoredProvisioner.Type;
const ProvisionerJson = Schema.fromJsonString(StoredProvisioner);
const decodeProvisionerJson = Schema.decodeOption(ProvisionerJson);
export const decodeProvisioner = (json: string) =>
  Option.getOrUndefined(decodeProvisionerJson(json));
export const encodeProvisioner = Schema.encodeSync(ProvisionerJson);

const ProfileGrant = Schema.Struct({
  capabilities: Schema.Array(Schema.String),
  runtimeMode: Schema.String,
  /** null allows every host. */
  hosts: Schema.NullOr(Schema.Array(Schema.String)),
});
/**
 * The provisioner's grant recorded at attach start, as keyed writes record theirs: a thread's modes
 * and goatclaw profile (null while goatclaw is off), or a person session's scopes. Each effect
 * admission needs at least this much again.
 */
const Delegation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    runtimeMode: Schema.String,
    interactionMode: Schema.String,
    goatclaw: Schema.NullOr(ProfileGrant),
  }),
  Schema.Struct({ kind: Schema.Literal("person"), scopes: Schema.Array(Schema.String) }),
]);
export type Delegation = typeof Delegation.Type;
const DelegationJson = Schema.fromJsonString(Delegation);
const decodeDelegationJson = Schema.decodeOption(DelegationJson);
/** An unreadable delegation reads as none, which no live grant covers. */
export const decodeDelegation = (json: string) => Option.getOrUndefined(decodeDelegationJson(json));
export const encodeDelegation = Schema.encodeSync(DelegationJson);

const rank = (mode: string) => RuntimeMode.literals.indexOf(mode as RuntimeMode);
// plan cannot do what default does, so default is the broader interaction mode.
const interactionRank = (mode: string) => (mode === "default" ? 1 : 0);
const holdsAll = (held: ReadonlyArray<string>, needed: ReadonlyArray<string>) =>
  needed.every((item) => held.includes(item));
type ProfileGrant = typeof ProfileGrant.Type;
const coversProfile = (current: ProfileGrant, recorded: ProfileGrant | null) =>
  recorded !== null &&
  holdsAll(current.capabilities, recorded.capabilities) &&
  rank(current.runtimeMode) >= rank(recorded.runtimeMode) &&
  (current.hosts === null || (recorded.hosts !== null && holdsAll(current.hosts, recorded.hosts)));

/**
 * Whether the provisioner's grant now still holds everything recorded at attach start, by the rule
 * keyed replays use (ToolAdmission.ts): goatclaw off applies no profile, so it covers one recorded
 * while it was on; a person needs every scope again.
 */
export const coversDelegation = (
  current: Delegation | undefined,
  recorded: Delegation | undefined,
) => {
  if (current === undefined || recorded === undefined) return false;
  if (current.kind === "person")
    return recorded.kind === "person" && holdsAll(current.scopes, recorded.scopes);
  return (
    recorded.kind === "thread" &&
    rank(current.runtimeMode) >= rank(recorded.runtimeMode) &&
    interactionRank(current.interactionMode) >= interactionRank(recorded.interactionMode) &&
    (current.goatclaw === null || coversProfile(current.goatclaw, recorded.goatclaw))
  );
};
const decodeStrings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
export const conflictCount = (json: string) =>
  Option.match(decodeStrings(json), { onNone: () => 1, onSome: (list) => list.length });

/** The fixed text a caller sees per state (design section 2, "What the caller sees"). */
export const stateMessage = (
  state: string,
  name: string,
  removedFromPen: boolean,
  admitted: boolean,
): { readonly message: string; readonly nextAction: string | null } => {
  if (state === "failed" && removedFromPen)
    return {
      message: name + " was removed from Pen before its attach finished.",
      nextAction: "Attach again with a new request.",
    };
  switch (state) {
    case "invited":
      return {
        message: "Waiting for the machine to join with the invite.",
        nextAction:
          "Run pen join with the token on the machine that holds these keys; the invite lasts 10 minutes.",
      };
    case "admitted":
      return {
        message: name + " joined Pen.",
        nextAction:
          "Linking it as a Child is not available yet; it stays a Pen member until a person removes it from Pen.",
      };
    case "unknown":
      return {
        message:
          "GOAT cannot tell whether the invite admitted the machine; it asks Pen again on each pass. If Pen lost the invite or saved no admit, a person can Release the attach in Settings → Hub on web or desktop once the invite has expired, which frees its slot if Pen shows the machine did not join.",
        nextAction:
          "Refresh the machine list later, or ask a person to release the attach in Settings → Hub on web or desktop once its invite expired.",
      };
    case "paused":
      // Paused covers both a join after the attach lost its authority and a withdrawal in flight.
      return admitted
        ? {
            message:
              name +
              " joined Pen after its attach lost its authority: the consent changed or ended, or the provisioner's grant did.",
            nextAction:
              "If it should not stay, remove it from Pen with pen revoke. Resuming an attach is not available yet.",
          }
        : {
            message:
              "GOAT is withdrawing this invite because its attach lost its authority; Pen has not confirmed the cancel yet.",
            nextAction: "Refresh the machine list later; GOAT asks Pen again each time.",
          };
    case "failed":
      return {
        message: "The invite ended without admitting the machine.",
        nextAction: "Attach again with a new request.",
      };
    default:
      return { message: name + " is " + state + ".", nextAction: null };
  }
};

export const mintSteps = (effects: ReadonlyArray<AttachEffect>): ReadonlyArray<HubMachineStep> =>
  effects.map((effect) => ({
    step: "invite",
    outcome: effect.settled ?? (effect.state === "done" ? "ok" : effect.state),
  }));

export type { HubMachineStatus };
