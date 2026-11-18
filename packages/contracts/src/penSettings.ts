import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

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

/** On: a server in a Pen mesh lists the other members; opening one still needs hub:proxy. */
export const DEFAULT_PEN_HUB_NODES = true;
export const PenServerSettingsFields = {
  /** Keep one hub route per machine in this server's Pen mesh. It never installs GOAT anywhere. */
  penHubNodes: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PEN_HUB_NODES)),
  ),
};
export const PenServerSettingsPatchFields = { penHubNodes: Schema.optionalKey(Schema.Boolean) };
export const PenClientFields = {
  showPenMachines: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
};
export const PenClientPatchFields = { showPenMachines: Schema.optionalKey(Schema.Boolean) };
