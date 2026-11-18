import type { ComposerContextClipboardFragment, ImageContextRecord } from "@goat/contracts";
import {
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "@goat/shared/composerContextReferences";
import type { ChatImageAttachment } from "../../types";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@goat/shared/composerContextClipboard";

import { readMediaPng } from "../media/mediaContent";
import { fingerprintSnapshotPng, snapshotClipboardHtml } from "../snapshotClipboardFingerprint";

export async function copySnapshot(src: string, text: string, fragment: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Snapshot copying requires a secure browser connection.");
  }
  const png = readMediaPng(src);
  const formats = {
    "image/png": png,
    "text/plain": new Blob([text], { type: "text/plain" }),
    "text/html": png.then(
      async (image) =>
        new Blob([snapshotClipboardHtml(text, fragment, await fingerprintSnapshotPng(image))], {
          type: "text/html",
        }),
    ),
  };
  // Start writing within the click gesture, before the image fetch or decode completes.
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        ...formats,
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: new Blob([fragment], {
          type: COMPOSER_CONTEXT_CLIPBOARD_MIME,
        }),
      }),
    ]);
  } catch {
    // HTML carries the same snapshot metadata when custom clipboard formats are unsupported.
    await navigator.clipboard.write([new ClipboardItem(formats)]);
  }
}

export async function copyMessageSnapshot(
  image: ChatImageAttachment | undefined,
  source: ComposerContextClipboardFragment["source"],
): Promise<void> {
  if (!image?.previewUrl || image.source?.kind !== "snap-shot")
    throw new Error("This snapshot is no longer available.");
  const record: ImageContextRecord = {
    version: 1,
    kind: "image",
    contextId: toKindScopedComposerContextId("image", image.id),
    label: image.name,
    attachmentId: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    source: image.source,
  };
  const fragment = encodeComposerContextFragment({ version: 1, source, records: [record] });
  if (!fragment) throw new Error("This snapshot could not be copied.");
  await copySnapshot(image.previewUrl, formatComposerContextReference(record), fragment);
}
