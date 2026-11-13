// @effect-diagnostics-next-line nodeBuiltinImport:off -- node ids are a digest of the signing key, as Pen derives them.
import * as NodeCrypto from "node:crypto";

import type { HubMachineStatus, HubMachineStep } from "@goat/contracts";

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
export interface AttachEffect {
  readonly id: string;
  readonly kind: "mint";
  readonly state: "intent" | "done" | "unknown" | "late";
  readonly inviteId?: string;
  /** The absolute expiry GOAT sent with the mint; after it, Pen can no longer create that invite. */
  readonly expiresAtMs?: number;
  /** The reissue request that started it, so a repeat replays instead of minting again. */
  readonly requestKey?: string;
}

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
