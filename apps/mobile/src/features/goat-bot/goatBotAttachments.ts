import type { ChatAttachment, EnvironmentId } from "@goat/contracts";

import { prepareTurnAttachments } from "../../lib/attachmentUpload";
import type { DraftComposerAttachment } from "../../lib/composerImages";

/**
 * Uploads a GOAT Bot message's files and returns the references ingest names. `remember` keeps the
 * uploaded ids, so a retry under the same message key names the same uploads.
 */
export async function uploadGoatBotAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly remember: (attachments: ReadonlyArray<DraftComposerAttachment>) => void;
}): Promise<ReadonlyArray<ChatAttachment>> {
  if (input.attachments.length === 0) return [];
  const prepared = await prepareTurnAttachments({
    environmentId: input.environmentId,
    attachments: input.attachments,
    supportsImageUploads: true,
    persistUploadedReferences: async (attachments) => {
      input.remember(attachments);
      return "persisted";
    },
  });
  if (prepared.status !== "ready") throw new Error("Upload cancelled.");
  return prepared.attachments.map((attachment) => {
    // GOAT Bot takes stored uploads only; inline image data has nowhere to go.
    if ("dataUrl" in attachment) throw new Error(`Couldn't upload '${attachment.name}'.`);
    return attachment;
  });
}
