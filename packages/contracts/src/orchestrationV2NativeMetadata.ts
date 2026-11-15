import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

// POSIX, drive-letter or UNC; a client import can set Cursor's store folder, never a relative one.
const AbsoluteHostPath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/),
);

export const OrchestrationV2ProviderThreadNativeMetadata = Schema.Struct({
  cursorStoreCwd: Schema.optional(AbsoluteHostPath),
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
