import { GOAT_CONTEXT_CLIPBOARD_MIME } from "@goat/contracts/legacyT3Names";
import * as Schema from "effect/Schema";

import { EnvironmentId, MessageId, ThreadId } from "./baseSchemas.ts";
import { COMPOSER_CONTEXT_MAX_RECORDS, ComposerContextRecord } from "./composerContext.ts";
import { ForwardCompatibleArray } from "./baseSchemas.ts";

/**
 * Structured clipboard payload for context copied between drafts and messages. Carries the
 * records behind the copied links plus where they came from, never bytes or URLs; the receiver
 * resolves binaries through its own environment.
 */
export const COMPOSER_CONTEXT_CLIPBOARD_MIME = `web ${GOAT_CONTEXT_CLIPBOARD_MIME}`;

export const ComposerContextClipboardFragment = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.Struct({
    environmentId: EnvironmentId,
    threadId: Schema.optional(ThreadId),
    messageId: Schema.optional(MessageId),
  }),
  // Bound raw input before forward-compatible decoding drops unknown records.
  records: Schema.Array(Schema.Unknown)
    .check(Schema.isMaxLength(COMPOSER_CONTEXT_MAX_RECORDS))
    .pipe(Schema.decodeTo(ForwardCompatibleArray(ComposerContextRecord))),
});
export type ComposerContextClipboardFragment = typeof ComposerContextClipboardFragment.Type;
