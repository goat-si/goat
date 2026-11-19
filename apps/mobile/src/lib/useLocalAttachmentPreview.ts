import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, AsyncResult } from "effect/reactivity";
import type { FileBackedComposerAttachment } from "./composerImages";
import type { AttachmentPreviewFile } from "./attachmentDownload";
import { loadLocalAttachmentPreview } from "./localAttachmentPreview";

class LocalAttachmentPreviewKey implements Equal.Equal {
  constructor(readonly attachment: FileBackedComposerAttachment) {}
  [Equal.symbol](that: unknown): boolean {
    return (
      that instanceof LocalAttachmentPreviewKey &&
      that.attachment.id === this.attachment.id &&
      that.attachment.fileUri === this.attachment.fileUri
    );
  }
  [Hash.symbol](): number {
    return Hash.string(`${this.attachment.id}\u0000${this.attachment.fileUri}`);
  }
}

class LocalAttachmentPreviewLoadError extends Schema.TaggedError<LocalAttachmentPreviewLoadError>()(
  "LocalAttachmentPreviewLoadError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const localAttachmentPreviewFamily = Atom.family((key: LocalAttachmentPreviewKey) =>
  Atom.make(
    // The lease lives as long as the atom: unmounting the last reader (or a
    // refresh) closes the scope and releases the file.
    Effect.acquireRelease(
      Effect.tryPromise({
        try: (signal) => loadLocalAttachmentPreview(key.attachment, signal),
        catch: (cause) =>
          new LocalAttachmentPreviewLoadError({
            message: cause instanceof Error ? cause.message : "The local file is unavailable.",
            cause,
          }),
      }).pipe(
        Effect.filterOrElse(
          (file) => file !== null,
          () => Effect.interrupt,
        ),
      ),
      (file) => Effect.sync(file.dispose),
    ),
  ).pipe(Atom.withLabel(`local-attachment-preview:${key.attachment.id}`)),
);

const noLocalAttachmentPreview = Atom.make(
  AsyncResult.initial<AttachmentPreviewFile, Error>(),
).pipe(Atom.withLabel("local-attachment-preview:none"));

export function localAttachmentPreviewAtom(
  attachment: FileBackedComposerAttachment | null,
): Atom.Atom<AsyncResult.AsyncResult<AttachmentPreviewFile, Error>> {
  return attachment === null
    ? noLocalAttachmentPreview
    : localAttachmentPreviewFamily(new LocalAttachmentPreviewKey(attachment));
}

export interface LocalAttachmentPreviewState {
  readonly uri: string | null;
  readonly error: Error | null;
}

export function localAttachmentPreviewState(
  result: AsyncResult.AsyncResult<AttachmentPreviewFile, Error>,
): LocalAttachmentPreviewState {
  return {
    // A refresh has already released the previous lease while it reacquires.
    uri: result._tag === "Success" && !result.waiting ? result.value.uri : null,
    error: result._tag === "Failure" ? Option.getOrNull(AsyncResult.error(result)) : null,
  };
}

export function useLocalAttachmentPreview(
  attachment: FileBackedComposerAttachment | null,
): LocalAttachmentPreviewState {
  return localAttachmentPreviewState(useAtomValue(localAttachmentPreviewAtom(attachment)));
}
