import { TrimmedNonEmptyString } from "@goat/contracts";
import * as Schema from "effect/Schema";

/** The key ToolAdmission reserves for a write the registry marks `idempotency: "key"`. */
export const KeyedClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
  description:
    "Idempotency key for retrying this write. A repeat with the same key and arguments returns the first call's result without running again; the same key with other arguments is refused. Use a new key for each new request.",
});

export const withClientRequestId = <Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
) => Schema.Struct({ ...schema.fields, clientRequestId: Schema.optional(KeyedClientRequestId) });
