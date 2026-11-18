import { ComposerContextId } from "@goat/contracts";
import type { ComposerContextClipboardFragment } from "@goat/contracts";
import { readComposerContextClipboardFragment } from "@goat/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
} from "@goat/shared/composerContextReferences";
import { readSnapshotClipboardWrapper } from "./snapshotClipboardFingerprint";

export function readPastedPlainText(clipboardData: Pick<DataTransfer, "getData">): string {
  return clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
}

export function readPastedComposerContext(
  clipboardData: Pick<DataTransfer, "getData">,
): ComposerContextClipboardFragment | null {
  const pastedText = clipboardData.getData("text/plain");
  // Only records whose links are in the pasted text get imported; a fragment may carry
  // more (it was built for a larger copy) and must not start transfers for those.
  const decodedFragment = readComposerContextClipboardFragment(clipboardData);
  if (decodedFragment === null) return null;
  const pastedIds = new Set<string>(
    collectComposerContextReferences(pastedText).map((occurrence) => occurrence.contextId),
  );
  for (const record of decodedFragment.records) {
    if (
      record.kind === "preview-annotation" &&
      !("payload" in record) &&
      pastedIds.has(record.contextId) &&
      record.screenshotContextId
    ) {
      pastedIds.add(record.screenshotContextId);
    }
  }
  return {
    ...decodedFragment,
    records: decodedFragment.records.filter((record) => pastedIds.has(record.contextId)),
  };
}

export function importPastedComposerText(
  clipboardData: Pick<DataTransfer, "getData">,
  importContextFragment?: (
    fragment: ComposerContextClipboardFragment,
  ) => ReadonlyMap<string, string>,
): string {
  const pastedText = readPastedPlainText(clipboardData);
  const fragment = importContextFragment ? readPastedComposerContext(clipboardData) : null;
  const rewrittenIds =
    fragment && fragment.records.length > 0 ? importContextFragment!(fragment) : null;
  const text =
    rewrittenIds && rewrittenIds.size > 0
      ? replaceComposerContextReferences(pastedText, (occurrence) => {
          const nextId = rewrittenIds.get(occurrence.contextId);
          return nextId
            ? formatComposerContextReference({
                ...occurrence,
                contextId: ComposerContextId.make(nextId),
                kind: occurrence.kind === "element" ? "preview-annotation" : occurrence.kind,
              })
            : occurrence.source;
        })
      : pastedText;
  return text;
}

export function readSnapshotPngPaste(clipboard: Pick<DataTransfer, "getData" | "files">) {
  const file = clipboard.files[0];
  if (clipboard.files.length !== 1 || file?.type !== "image/png") return null;

  const wrapper = readSnapshotClipboardWrapper(clipboard.getData("text/html"));
  if (!wrapper) return null;
  const text = clipboard.getData("text/plain");
  const clipboardData = {
    getData: (type: string) =>
      type === "text/plain" ? text : type === "text/html" ? wrapper.html : "",
  };
  const records = readPastedComposerContext(clipboardData)?.records;
  const record = records?.length === 1 ? records[0] : undefined;
  if (
    record?.kind !== "image" ||
    "payload" in record ||
    record.source?.kind !== "snap-shot" ||
    text !== formatComposerContextReference(record)
  )
    return null;
  return { file, clipboardData, fingerprint: wrapper.fingerprint };
}
