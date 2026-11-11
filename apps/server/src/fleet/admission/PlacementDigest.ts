import type { ChatAttachment } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest over bytes already read.
import * as NodeCrypto from "node:crypto";

/**
 * The digest a target computes over a placed launch (design §11). It covers every decoded
 * goat_thread_launch field except the ones listed here, so a field added to the schema later is
 * covered unless someone excludes it on purpose.
 */
export const DIGEST_EXCLUDED_FIELDS: ReadonlySet<string> = new Set(["placement"]);

export class PlacementAttachmentUnavailable extends Schema.TaggedError<PlacementAttachmentUnavailable>()(
  "PlacementAttachmentUnavailable",
  { name: Schema.String },
) {}

export interface DigestInput<E> {
  /** The decoded tool parameters, defaults applied. */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Every top-level field the schema declares, so an absent one is written as null. */
  readonly fieldNames: ReadonlyArray<string>;
  readonly principal: { readonly kind: string; readonly runtimeCeiling: string };
  /** The stored bytes of a pending upload, or null when they are gone. */
  readonly attachmentBytes: (attachment: ChatAttachment) => Effect.Effect<Uint8Array | null, E>;
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .toSorted()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
};

/** Attachments by content: a re-upload under a new id digests the same. */
const attachmentContent = Effect.fn("PlacementDigest.attachmentContent")(function* <E>(
  attachment: ChatAttachment,
  read: DigestInput<E>["attachmentBytes"],
) {
  const bytes = yield* read(attachment);
  if (bytes === null || bytes.byteLength !== attachment.sizeBytes)
    return yield* new PlacementAttachmentUnavailable({ name: attachment.name });
  return {
    type: attachment.type,
    sha256: sha256(bytes),
    size: bytes.byteLength,
    mediaType: attachment.mimeType,
    name: attachment.name,
  };
});

export const placementDigest = Effect.fn("PlacementDigest.compute")(function* <E>(
  input: DigestInput<E>,
) {
  const fields: Record<string, unknown> = {};
  // Only declared fields: anything else a caller sends, such as its own hash, is not part of it.
  for (const name of input.fieldNames) {
    if (DIGEST_EXCLUDED_FIELDS.has(name)) continue;
    fields[name] = input.parameters[name] ?? null;
  }
  const attachments = input.parameters.attachments;
  if (Array.isArray(attachments))
    fields.attachments = yield* Effect.forEach(
      attachments as ReadonlyArray<ChatAttachment>,
      (attachment) => attachmentContent(attachment, input.attachmentBytes),
    );
  fields.principal = input.principal;
  return sha256("goat-placement/1" + encodeJson(canonical(fields)));
});
