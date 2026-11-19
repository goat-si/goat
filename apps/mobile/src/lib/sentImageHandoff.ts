export interface SentImageHandoff {
  readonly uri: string;
  readonly aspectRatio: number;
}

const MAX_ENTRIES = 64;
const images = new Map<string, SentImageHandoff>();

function remember(key: string, image: SentImageHandoff) {
  if (!Number.isFinite(image.aspectRatio) || image.aspectRatio <= 0) return;
  images.delete(key);
  images.set(key, image);
  if (images.size > MAX_ENTRIES) {
    const oldest = images.keys().next().value;
    if (oldest !== undefined) images.delete(oldest);
  }
}

export function rememberDraftImage(
  environmentId: string,
  attachmentId: string,
  image: SentImageHandoff,
): void {
  remember(JSON.stringify([environmentId, "draft", attachmentId]), image);
}

export function rememberSentImage(
  environmentId: string,
  messageId: string,
  index: number,
  image: SentImageHandoff,
): void {
  remember(JSON.stringify([environmentId, "message", messageId, index]), image);
}

export function sentImageHandoff(
  environmentId: string,
  messageId: string,
  index: number,
  draftAttachmentId?: string,
): SentImageHandoff | undefined {
  return (
    images.get(JSON.stringify([environmentId, "message", messageId, index])) ??
    (draftAttachmentId === undefined
      ? undefined
      : images.get(JSON.stringify([environmentId, "draft", draftAttachmentId])))
  );
}
