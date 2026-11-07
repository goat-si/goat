import { resolveAssetUrl } from "@goat/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  formatAttachmentSize,
  runAttachmentUploadCycle,
} from "@goat/client-runtime/state/attachments";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type EnvironmentId,
} from "@goat/contracts";
import { uploadBytes } from "../lib/attachmentUploadQueue";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { notesRpc } from "../rpc/notes/atoms";
import { attachmentEnvironment } from "../state/attachments";
import { readPreparedConnection } from "../state/session";
import { uploadName } from "./noteUploadPlaceholders";

export type NoteUpload =
  | { readonly ok: true; readonly name: string; readonly path: string }
  | {
      readonly ok: false;
      readonly name: string;
      readonly message: string;
      readonly cancelled: boolean;
    };

const IMAGE_TYPES: ReadonlySet<string> = new Set(PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES);
const isImageType = (
  mimeType: string,
): mimeType is (typeof PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES)[number] =>
  IMAGE_TYPES.has(mimeType);
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "The upload did not finish.";

/**
 * Uploads one file through the environment's signed upload and moves it into the notes. Every way
 * out after the server minted an upload, including abort, deletes that pending upload, except once
 * notes.attach is underway: the server then finishes publishing and the file stays in the notes.
 */
export async function uploadNoteFile(input: {
  readonly environmentId: EnvironmentId;
  readonly file: File;
  readonly signal: AbortSignal;
}): Promise<NoteUpload> {
  const { environmentId, file, signal } = input;
  const name = uploadName(file);
  const mimeType = file.type || "application/octet-stream";
  const failed = (message: string, cancelled = false): NoteUpload => ({
    ok: false,
    name,
    message,
    cancelled,
  });
  if (file.size === 0) return failed(`${name} is empty.`);
  if (file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
    return failed(
      `${name} is larger than ${formatAttachmentSize(PROVIDER_SEND_TURN_MAX_FILE_BYTES)}.`,
    );
  const release = async (attachmentId: string) => {
    const deleted = await deletePendingAttachmentUpload({
      registry: appAtomRegistry,
      remove: attachmentEnvironment.remove,
      environmentId,
      attachmentId,
    });
    if (!deleted.ok)
      console.warn("[notes] could not delete an abandoned upload", {
        attachmentId,
        error: deleted.error,
      });
  };
  const cycle = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    // Large images still upload, as files, under the higher file limit.
    upload:
      isImageType(mimeType) && file.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        ? { name, mimeType, sizeBytes: file.size }
        : { type: "file", name, mimeType, sizeBytes: file.size },
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) => uploadBytes({ url, file, mimeType, onProgress: () => {} }),
    onMinted: () => (signal.aborted ? "cancel" : "continue"),
    onTransferStart: (abort) => signal.addEventListener("abort", abort, { once: true }),
  });
  if (cycle.status === "cancelled") {
    if (cycle.cleanupFailure)
      console.warn("[notes] could not delete an abandoned upload", cycle.cleanupFailure);
    return failed("Cancelled.", true);
  }
  if (cycle.status === "failed") {
    if (cycle.attachmentId !== null) await release(cycle.attachmentId);
    return signal.aborted ? failed("Cancelled.", true) : failed(messageOf(cycle.error));
  }
  if (signal.aborted) {
    await release(cycle.attachmentId);
    return failed("Cancelled.", true);
  }
  const attached = await runAtomCommand(
    appAtomRegistry,
    notesRpc.attach,
    { environmentId, input: { attachmentId: cycle.attachmentId } },
    { reportFailure: false },
  );
  if (attached._tag !== "Success") {
    await release(cycle.attachmentId);
    return failed(messageOf(squashAtomCommandFailure(attached)));
  }
  return { ok: true, name, path: attached.value.path };
}
