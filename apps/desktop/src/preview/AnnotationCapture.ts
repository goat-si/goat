import type { PreviewAnnotationPayload, PreviewAnnotationRect } from "@goat/contracts";

export const normalizeCaptureRect = (value: unknown): PreviewAnnotationRect | null => {
  if (typeof value !== "object" || value === null) return null;
  const rect = value as Record<string, unknown>;
  const x = rect["x"];
  const y = rect["y"];
  const width = rect["width"];
  const height = rect["height"];
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
};

// capturePage returns a 1x NativeImage containing device pixels, so crop() uses
// CSS coordinates scaled by the guest's devicePixelRatio (including page zoom).
export const cropAnnotationScreenshot = (
  image: Electron.NativeImage,
  cropRect: PreviewAnnotationRect | null,
  devicePixelRatio: number,
  targetRects: ReadonlyArray<PreviewAnnotationRect>,
): PreviewAnnotationPayload["screenshot"] => {
  const full = image.getSize();
  if (full.width <= 0 || full.height <= 0) return null;
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  // Padding or a union of offscreen targets can overlap an empty viewport area.
  // A zero-width/height SVG line can still paint at the top or left edge.
  if (
    targetRects.length > 0 &&
    !targetRects.some(
      (rect) =>
        (rect.width > 0 || rect.height > 0) &&
        rect.x * scale < full.width &&
        rect.y * scale < full.height &&
        (rect.width === 0 ? rect.x >= 0 : rect.x + rect.width > 0) &&
        (rect.height === 0 ? rect.y >= 0 : rect.y + rect.height > 0),
    )
  ) {
    return null;
  }
  if (!cropRect) {
    return {
      dataUrl: image.toDataURL(),
      width: full.width,
      height: full.height,
      cropRect: { x: 0, y: 0, width: full.width, height: full.height },
    };
  }
  const x = Math.max(0, Math.floor(cropRect.x * scale));
  const y = Math.max(0, Math.floor(cropRect.y * scale));
  const right = Math.min(full.width, Math.ceil((cropRect.x + cropRect.width) * scale));
  const bottom = Math.min(full.height, Math.ceil((cropRect.y + cropRect.height) * scale));
  // A target scrolled out of view has no pixels in this capture. Clamping its
  // origin onto the edge would attach an unrelated strip as a successful crop.
  if (right <= x || bottom <= y) return null;
  const cropped = image.crop({
    x,
    y,
    width: right - x,
    height: bottom - y,
  });
  const size = cropped.getSize();
  if (size.width <= 0 || size.height <= 0) return null;
  return { dataUrl: cropped.toDataURL(), width: size.width, height: size.height, cropRect };
};
