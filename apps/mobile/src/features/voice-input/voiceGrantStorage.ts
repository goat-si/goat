import { EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";

const Grant = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  environmentId: EnvironmentId,
});
export type VoiceGrant = typeof Grant.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Grant));

export function createVoiceGrantStorage(input: {
  readSecret: () => Promise<string | null>;
  writeSecret: (value: string) => void;
  /** Null when the marker is missing, which revokes the grant. */
  readMarker: () => string | null;
  writeMarker: (value: string) => void;
  newId: () => string;
}) {
  return {
    async read(): Promise<VoiceGrant | null> {
      const raw = await input.readSecret();
      if (!raw) return null;
      const grant = decode(raw);
      return input.readMarker() === grant.id ? grant : null;
    },
    choose(environmentId: EnvironmentId | null): VoiceGrant | null {
      const grant = environmentId === null ? null : { id: input.newId(), environmentId };
      input.writeMarker(grant?.id ?? "");
      input.writeSecret(grant ? JSON.stringify(grant) : "");
      return grant;
    },
  };
}
