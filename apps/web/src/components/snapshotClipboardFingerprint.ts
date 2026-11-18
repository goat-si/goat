import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@goat/contracts";
import { encodeComposerContextClipboardHtml } from "@goat/shared/composerContextClipboard";

const MAX_FINGERPRINT_PIXELS = 16 * 1024 * 1024;
const SNAPSHOT_PNG_ATTRIBUTE = "data-goat-snapshot-png";
// A single snapshot's escaped accessibility data and icon fit under this ceiling.
const MAX_SNAPSHOT_HTML_CHARS = 2 * 1024 * 1024;
const FINGERPRINT_ASSIGNMENT = `${SNAPSHOT_PNG_ATTRIBUTE}=`;
const HTML_WHITESPACE = /[\t\n\f\r ]/;
const FINGERPRINT = /^[0-9]{1,8}x[0-9]{1,8}:[0-9a-f]{64}$/;

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
  if (html.length > MAX_SNAPSHOT_HTML_CHARS) return null;

  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start === -1) return null;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end === -1) return null;
      cursor = end + 3;
      continue;
    }

    const pre = html.startsWith("<pre", start) && HTML_WHITESPACE.test(html.charAt(start + 4));
    let fingerprint: string | undefined;
    let end = start + 1;
    for (; end < html.length; end += 1) {
      const char = html[end];
      if (char === "<" || char === ">") break;
      if (char !== '"' && char !== "'") continue;
      const closeQuote = html.indexOf(char, end + 1);
      if (closeQuote === -1) return null;
      const nameStart = end - FINGERPRINT_ASSIGNMENT.length;
      if (
        pre &&
        HTML_WHITESPACE.test(html.charAt(nameStart - 1)) &&
        html.startsWith(FINGERPRINT_ASSIGNMENT, nameStart)
      ) {
        const value = html.slice(end + 1, closeQuote);
        if (FINGERPRINT.test(value)) fingerprint = value;
      }
      end = closeQuote;
    }
    if (html[end] === ">" && fingerprint) {
      return { html: html.slice(start, end + 1), fingerprint };
    }
    cursor = html[end] === "<" ? end : end + 1;
  }
  return null;
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
