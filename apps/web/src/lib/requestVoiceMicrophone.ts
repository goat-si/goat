export async function requestVoiceMicrophone(
  open: () => Promise<MediaStream>,
  restart: (() => Promise<boolean>) | undefined,
  isCurrent: () => boolean,
): Promise<MediaStream> {
  try {
    return await open();
  } catch (error) {
    if (
      !(error instanceof DOMException) ||
      !["NotFoundError", "NotReadableError"].includes(error.name) ||
      !restart ||
      !isCurrent()
    )
      throw error;
    const restarted = await restart().catch(() => false);
    if (!restarted || !isCurrent()) throw error;
    return open();
  }
}
