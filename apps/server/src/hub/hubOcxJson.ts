import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** What OpenCodex prints with --json for the commands the hub runs. */
export const LinkStatus = Schema.Struct({
  role: Schema.Literals(["standalone", "home", "child"]),
  links: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      alias: Schema.String,
      tunnelPort: Schema.optional(Schema.Number),
    }),
  ),
});
export const Health = Schema.Struct({
  service: Schema.String,
  role: Schema.optional(Schema.String),
});
export const Probe = Schema.Struct({
  alias: Schema.String,
  fingerprint: Schema.String,
  keyType: Schema.String,
});
export const Added = Schema.Struct({ linkId: Schema.String });
/** `ocx connect status --json`; `transport: "link"` is a Remote Link Child's saved connection. */
export const Connection = Schema.Struct({
  state: Schema.String,
  transport: Schema.optional(Schema.String),
  serverUrl: Schema.optional(Schema.String),
  apiKeyId: Schema.optional(Schema.String),
});
export const decodeJson = <A, I>(schema: Schema.Codec<A, I>, text: string) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text.trim()));
