import * as Schema from "effect/Schema";

export const serverCapabilityFields = {
  threadFindProgressive: Schema.optionalKey(Schema.Boolean),
  secretProviderSettings: Schema.optionalKey(Schema.Boolean),
  secretReferences: Schema.optionalKey(Schema.Boolean),
};
