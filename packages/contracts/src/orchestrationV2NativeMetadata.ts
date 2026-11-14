import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const OrchestrationV2ProviderThreadNativeMetadata = Schema.Struct({
  cursorStoreCwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  title: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  itemIdentityVersion: Schema.optional(Schema.Literal(2)),
  forkHeadMessageId: Schema.optional(TrimmedNonEmptyString),
  claudeAttachmentBudget: Schema.optional(
    Schema.Struct({ bytesUsed: NonNegativeInt, pagesUsed: NonNegativeInt }),
  ),
});
export type OrchestrationV2ProviderThreadNativeMetadata =
  typeof OrchestrationV2ProviderThreadNativeMetadata.Type;
