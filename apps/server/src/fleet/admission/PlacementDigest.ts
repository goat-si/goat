import {
  type ChatAttachment,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest over bytes already read.
import * as NodeCrypto from "node:crypto";

/**
 * The digest a target computes over a placed launch (design §11). It covers every decoded
 * goat_thread_launch field except the ones listed here, so a field added to the schema later is
 * covered unless someone excludes it on purpose.
 */
const DIGEST_EXCLUDED_FIELDS: ReadonlySet<string> = new Set(["placement"]);

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

/**
 * The attachment's bytes when the file holds exactly its declared size, which must be within the
 * attachment limit; null otherwise. Never holds more than one byte past that size in memory.
 */
export const readAttachmentExactly = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  attachment: Pick<ChatAttachment, "type" | "sizeBytes">,
) => {
  const limit =
    attachment.type === "image"
      ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  const size = attachment.sizeBytes;
  if (!Number.isInteger(size) || size < 0 || size > limit) return Effect.succeed(null);
  return fileSystem.stream(path, { bytesToRead: size + 1 }).pipe(
    Stream.runFold(
      () => ({ chunks: [] as Array<Uint8Array>, length: 0 }),
      (read, chunk) => {
        read.chunks.push(chunk);
        read.length += chunk.byteLength;
        return read;
      },
    ),
    Effect.map((read) => {
      if (read.length !== size) return null;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of read.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }),
    Effect.orElseSucceed(() => null),
  );
};
