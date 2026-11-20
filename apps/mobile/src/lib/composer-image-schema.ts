import * as Schema from "effect/Schema";
import { EnvironmentId, PastedTextAttachmentSource } from "@goat/contracts";

export const DraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  fileUri: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  dataUrl: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  uploadedAttachmentId: Schema.optional(Schema.String),
  uploadEnvironmentId: Schema.optional(EnvironmentId),
}).check(
  Schema.makeFilter(
    ({ fileUri, dataUrl }) =>
      fileUri !== undefined ||
      dataUrl !== undefined ||
      "Image attachment has no file or inline bytes.",
  ),
);

export const DraftComposerFileAttachmentSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("file"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  fileUri: Schema.String,
  source: Schema.optional(PastedTextAttachmentSource),
  uploadedAttachmentId: Schema.optional(Schema.String),
  uploadEnvironmentId: Schema.optional(EnvironmentId),
});

export const DraftComposerAttachmentSchema = Schema.Union([
  DraftComposerImageAttachmentSchema,
  DraftComposerFileAttachmentSchema,
]);

export function normalizeId(id: string): string {
  return id.replace(/^(.*):(file|image):(\d+)$/, "$1-$2-$3");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizePersistedShareDraft(value: unknown): unknown {
  const draft = objectRecord(value);
  if (!draft || !Array.isArray(draft.attachments)) return value;
  const replacements = new Map<string, string>();
  const validAttachment = Schema.is(DraftComposerAttachmentSchema);
  const seen = new Set<string>();
  const attachments = draft.attachments.flatMap((item) => {
    const attachment = objectRecord(item);
    if (!attachment || typeof attachment.id !== "string" || !validAttachment(item)) return [item];
    const normalized = normalizeId(attachment.id);
    if (normalized !== attachment.id) replacements.set(attachment.id, normalized);
    if (seen.has(normalized)) return [];
    seen.add(normalized);
    if (normalized === attachment.id) return [item];
    return [{ ...attachment, id: normalized }];
  });
  const context = objectRecord(draft.context);
  const records = context?.records;
  const nextContext = Array.isArray(records)
    ? {
        ...context,
        records: records.map((entry) => {
          const record = objectRecord(entry);
          if (!record || typeof record.attachmentId !== "string") return entry;
          const replacement = replacements.get(record.attachmentId);
          return replacement ? { ...record, attachmentId: replacement } : entry;
        }),
      }
    : draft.context;
  return { ...draft, attachments, ...(context ? { context: nextContext } : {}) };
}

export function normalizeDocument(value: unknown): unknown {
  const document = objectRecord(value);
  if (!document) return value;
  const mapDrafts = (value: unknown): unknown => {
    const drafts = objectRecord(value);
    return drafts
      ? Object.fromEntries(
          Object.entries(drafts).map(([key, draft]) => [key, normalizePersistedShareDraft(draft)]),
        )
      : value;
  };
  const signedOut = objectRecord(document.signedOutDrafts);
  return {
    ...document,
    drafts: mapDrafts(document.drafts),
    ...(signedOut
      ? {
          signedOutDrafts: Object.fromEntries(
            Object.entries(signedOut).map(([key, value]) => {
              const saved = objectRecord(value);
              return [key, saved ? { ...saved, drafts: mapDrafts(saved.drafts) } : value];
            }),
          ),
        }
      : {}),
  };
}

export function attachmentId(attachment: { readonly id: string }): string {
  return normalizeId(attachment.id);
}
