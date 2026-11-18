import * as NodeZlib from "node:zlib";

// An invalid color space skips costly P3-to-sRGB conversion; fingerprints need no color accuracy.
const FINGERPRINT_BITMAP_OPTIONS: Electron.ToBitmapOptions = {
  colorSpace: { primaries: "invalid", transfer: "invalid", matrix: "invalid", range: "invalid" },
};

/** Empty readPixels results have no fingerprint and must be treated as changed frames. */
export const fingerprintCapturedFrame = (image: Electron.NativeImage, size: Electron.Size) => {
  let bitmap: Buffer;
  try {
    bitmap = image.toBitmap(FINGERPRINT_BITMAP_OPTIONS);
  } catch {
    return null;
  }
  if (bitmap.byteLength === 0) return null;
  return `${size.width}x${size.height}:${NodeZlib.crc32(bitmap)}`;
};
