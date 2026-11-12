import * as Schema from "effect/Schema";

/** A Pen mesh or node id: 26 base32 characters (pen-protocol CONTRACT "Identities"). */
export const PenId = Schema.String.check(Schema.isPattern(/^[a-z2-7]{26}$/u));

const PenRealPath = Schema.String.check(Schema.isPattern(/^\/[^\0]*$/u), Schema.isMaxLength(4096));

/**
 * The Pen this machine's GOAT trusts, pinned by a person's confirmation (mesh link design §7): the
 * real paths of the pen executable and its state folder, and the mesh and node this machine is.
 */
export const PenTrustRoot = Schema.Struct({
  executablePath: PenRealPath,
  stateDir: PenRealPath,
  meshId: PenId,
  nodeId: PenId,
});
export type PenTrustRoot = typeof PenTrustRoot.Type;
