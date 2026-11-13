import { ForwardCompatibleOptional } from "@goat/contracts";
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

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * What a newer `ocx link status --json` adds to a link row: body byte counters
 * (?traffic=1), the route in use on a link with several routes (?routes=1) and the link WebSocket
 * counters (?transport=1). Each is optional, and one that does not decode reads as not reported.
 */
export const LinkRowObservationFields = {
  traffic: ForwardCompatibleOptional(
    Schema.Struct({
      epoch: Schema.String.check(Schema.isPattern(/^[0-9a-f]{1,64}$/u)),
      generation: Count,
      toHomeBytes: Count,
      fromHomeBytes: Count,
    }),
  ),
  // Kept raw: either key marks a multi-route row even when its value does not decode.
  routes: Schema.optional(Schema.Unknown),
  route: Schema.optional(Schema.Unknown),
  ws: ForwardCompatibleOptional(Schema.Struct({ open: Count })),
};
/** The route a multi-route row's proven tunnel uses; null while none is proven. */
export const decodeLinkRowRoute = Schema.decodeUnknownOption(
  Schema.NullOr(Schema.Struct({ name: Schema.String, since: Schema.String })),
);
