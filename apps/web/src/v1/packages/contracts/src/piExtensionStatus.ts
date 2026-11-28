import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PiExtensionStatuses = Schema.optional(
  Schema.Array(
    Schema.Struct({
      key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      text: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
    }),
  ).check(Schema.isMaxLength(32)),
).pipe(Schema.withDecodingDefault(Effect.succeed([])));
