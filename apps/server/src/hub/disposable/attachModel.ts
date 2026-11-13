// @effect-diagnostics-next-line nodeBuiltinImport:off -- node ids are a digest of the signing key, as Pen derives them.
import * as NodeCrypto from "node:crypto";

import type { HubMachineStatus, HubMachineStep } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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

/** One side effect an attach started, with what settled it. */
const AttachEffect = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("mint"),
  state: Schema.Literals(["intent", "done", "unknown", "late"]),
  inviteId: Schema.optionalKey(Schema.String),
  /** The absolute expiry GOAT sent with the mint; after it, Pen can no longer create that invite. */
  expiresAtMs: Schema.optionalKey(Schema.Number),
  /** The reissue request that started it, so a repeat replays instead of minting again. */
  requestKey: Schema.optionalKey(Schema.String),
});
export type AttachEffect = typeof AttachEffect.Type;
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const EffectsJson = Schema.fromJsonString(Schema.Array(AttachEffect));
/** A record's effects; an unreadable list reads as none started, which keeps nothing settled. */
const decodeEffectsJson = Schema.decodeOption(EffectsJson);
export const decodeEffects = (json: string): ReadonlyArray<AttachEffect> =>
  Option.getOrElse(decodeEffectsJson(json), () => []);
export const encodeEffects = Schema.encodeSync(EffectsJson);

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
export const encodeUnknown = Schema.encodeSync(UnknownJson);
const decodeUnknownJson = Schema.decodeOption(UnknownJson);
export const decodeUnknown = (json: string) => Option.getOrUndefined(decodeUnknownJson(json));
const decodeStrings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
export const conflictCount = (json: string) =>
  Option.match(decodeStrings(json), { onNone: () => 1, onSome: (list) => list.length });

/** The fixed text a caller sees per state (design section 2, "What the caller sees"). */
export const stateMessage = (
  state: string,
  name: string,
  inviteExpiresAt: string | null,
): { readonly message: string; readonly nextAction: string | null } => {
  switch (state) {
    case "invited":
      return {
        message:
          "Waiting for the machine to join with the invite" +
          (inviteExpiresAt === null ? "." : " (expires " + inviteExpiresAt + ")."),
        nextAction: "Run pen join with the token on the machine that holds these keys.",
      };
    case "admitted":
      return { message: name + " joined Pen; checking its route.", nextAction: null };
    case "unknown":
      return {
        message: "GOAT cannot tell yet whether the invite admitted the machine.",
        nextAction: "Read goat_hub_machine_list again; it asks Pen for the invite's state.",
      };
    case "paused":
      return {
        message: "Paused: the consent this attach ran under changed.",
        nextAction: "A person resumes it in Settings, or removes the machine from Pen.",
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
    outcome: effect.state === "done" ? "ok" : effect.state,
  }));

export type { HubMachineStatus };
