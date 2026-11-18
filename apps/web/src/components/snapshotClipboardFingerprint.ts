import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@goat/contracts";
import { encodeComposerContextClipboardHtml } from "@goat/shared/composerContextClipboard";

const MAX_FINGERPRINT_PIXELS = 16 * 1024 * 1024;
const SNAPSHOT_PNG_ATTRIBUTE = "data-goat-snapshot-png";
const SNAPSHOT_WRAPPER = /<pre[^>]*\sdata-goat-snapshot-png="([0-9]+x[0-9]+:[0-9a-f]{64})"[^>]*>/;

export function snapshotClipboardHtml(
  text: string,
  fragment: string,
  fingerprint: string | null,
): string {
  const html = encodeComposerContextClipboardHtml(text, fragment);
  return fingerprint === null
    ? html
    : html.replace("<pre ", `<pre ${SNAPSHOT_PNG_ATTRIBUTE}="${fingerprint}" `);
}

export function readSnapshotClipboardWrapper(html: string) {
  const wrapper = SNAPSHOT_WRAPPER.exec(html);
  const fingerprint = wrapper?.[1];
  return wrapper && fingerprint ? { html: wrapper[0], fingerprint } : null;
}

export async function fingerprintSnapshotPng(png: Blob): Promise<string | null> {
  if (png.size < 24 || png.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return null;
  try {
    const header = new DataView(await png.slice(0, 24).arrayBuffer());
    if (
      header.getUint32(0) !== 0x89504e47 ||
      header.getUint32(4) !== 0x0d0a1a0a ||
      header.getUint32(12) !== 0x49484452
    )
      return null;
    const width = header.getUint32(16);
    const height = header.getUint32(20);
    if (width === 0 || height === 0 || width * height > MAX_FINGERPRINT_PIXELS) return null;

    // Native clipboard bridges can re-encode PNG bytes while preserving the image.
    const bitmap = await createImageBitmap(png);
    try {
      if (bitmap.width !== width || bitmap.height !== height) return null;
      const context = new OffscreenCanvas(width, height).getContext("2d");
      if (!context) return null;
      context.drawImage(bitmap, 0, 0);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        context.getImageData(0, 0, width, height).data,
      );
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return `${width}x${height}:${hex}`;
    } finally {
      bitmap.close();
    }
  } catch {
    // A copy can still carry its image and text when the browser cannot verify the pairing.
    return null;
  }
}
